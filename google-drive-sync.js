/* Optional Google Drive appDataFolder sync. Tokens live only in mount() memory. */
(() => {
  'use strict';
  const META_KEY = 'morning-report-hub.sync.v1';
  const SAFETY_KEY = 'morning-report-hub.sync-safety.v1';
  const FILE_NAME = 'morning-report-hub-sync.json';
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const MAX_BYTES = 10 * 1024 * 1024;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  class SyncError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  function canonicalJSON(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
    if (isObject(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
    throw new SyncError('format', '同期データに未対応の値があります。上書きせず停止しました。');
  }
  async function contentHash(data) {
    if (!globalThis.crypto?.subtle) throw new SyncError('setup', '同期にはHTTPSで開いたアプリが必要です。端末内保存は利用できます。');
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJSON(data)));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  function decideSync(localHash, remoteHash, baseline) {
    if (remoteHash === null) return 'missing';
    if (localHash === remoteHash) return 'equal';
    if (!baseline) return 'conflict';
    if (localHash !== baseline && remoteHash === baseline) return 'upload';
    if (localHash === baseline && remoteHash !== baseline) return 'download';
    return 'conflict';
  }
  async function validateEnvelope(raw, validatePayload) {
    try {
      if (!isObject(raw) || raw.format !== 'morning-report-hub-sync' || raw.syncVersion !== 1 ||
          typeof raw.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(raw.updatedAt) || !Number.isFinite(Date.parse(raw.updatedAt)) ||
          !/^[a-f0-9]{64}$/.test(raw.contentHash || '')) throw new Error();
      const data = validatePayload(raw.data);
      if (await contentHash(data) !== raw.contentHash) throw new Error();
      return {...raw, data};
    } catch (error) {
      if (error.code === 'setup') throw error;
      throw new SyncError('format', 'Driveデータの形式または整合性を確認できません。端末・Driveとも上書きせず停止しました。');
    }
  }
  const hasContent = data => Object.keys(data.records).length > 0 || Object.values(data.settings).some(v => v.trim());
  const defaultMeta = () => ({driveFileId:'',lastSyncedHash:'',lastSyncAt:'',localModifiedAt:'',clientId:''});

  // All writes go through the app bridge; this module never owns the core database.
  function createEngine({bridge, remote, readMeta, writeMeta, saveSafety, askInitial, askConflict, notify, assertSession}) {
    let busy = false;
    async function sync() {
      if (busy) return {kind:'busy'};
      busy = true;
      try {
        assertSession();
        notify('syncing', '同期中です。端末の記録は保存済みです。');
        const data = bridge.getSyncPayload(), expected = canonicalJSON(data), a = await contentHash(data);
        const meta = readMeta();
        const before = await remote.read();
        assertSession();
        const baseline = before && meta.driveFileId === before.id ? meta.lastSyncedHash : '';
        const action = decideSync(a, before ? before.envelope.contentHash : null, baseline);
        let choice = action;
        if (action === 'missing') {
          if (!await askInitial(Object.keys(data.records).length)) return {kind:'cancelled'};
          choice = 'upload';
        } else if (action === 'conflict') {
          notify('conflict', '端末とGoogle Driveに異なるデータがあります。自動上書きは停止しています。');
          choice = await askConflict({localCount:Object.keys(data.records).length,remoteCount:Object.keys(before.envelope.data.records).length,
            updatedAt:before.envelope.updatedAt,lastSyncAt:meta.lastSyncAt,initial:!baseline});
          if (!['upload','download'].includes(choice)) return {kind:'cancelled'};
        }
        assertSession();
        if (canonicalJSON(bridge.getSyncPayload()) !== expected) throw new SyncError('changed', '確認中に端末の記録が変わりました。上書きせず停止しました。「今すぐ同期」で比較し直してください。');
        let current = before;
        if (choice !== 'equal') {
          // Re-read after dialogs, before any destructive operation.
          current = await remote.read();
          assertSession();
          if (Boolean(current) !== Boolean(before) || (current && (current.id !== before.id || current.envelope.contentHash !== before.envelope.contentHash || current.revision !== before.revision))) {
            throw new SyncError('changed', '比較後にDriveのデータが変わりました。上書きせず停止しました。「今すぐ同期」で比較し直してください。');
          }
          if (canonicalJSON(bridge.getSyncPayload()) !== expected) throw new SyncError('changed', '同期中に端末の記録が変わりました。もう一度同期してください。');
        }
        let syncedHash = a, fileId = current?.id;
        if (choice === 'download') {
          if (!hasContent(current.envelope.data) && hasContent(data)) throw new SyncError('empty', 'Driveのデータが空のため、端末への反映を停止しました。端末の記録・設定は保持しています。');
          saveSafety('端末の上書き前', bridge.getLocalBackup());
          assertSession();
          bridge.applyRemoteSyncPayload(current.envelope.data, expected);
          syncedHash = current.envelope.contentHash;
        } else if (choice === 'upload') {
          if (current && action === 'conflict') saveSafety('Driveの上書き前', {...clone(current.envelope.data),draft:null,draftDay:''});
          assertSession();
          const envelope = {format:'morning-report-hub-sync',syncVersion:1,updatedAt:new Date().toISOString(),contentHash:a,data};
          await remote.write(current, envelope);
          assertSession();
          const verified = await remote.read();
          if (!verified || verified.envelope.contentHash !== a) throw new SyncError('changed', '送信後のDriveデータを確認できませんでした。端末データは保持しています。再同期してください。');
          fileId = verified.id;
        }
        assertSession();
        writeMeta({...readMeta(),driveFileId:fileId,lastSyncedHash:syncedHash,lastSyncAt:new Date().toISOString()});
        const dirty = canonicalJSON(bridge.getSyncPayload()) !== canonicalJSON(choice === 'download' ? current.envelope.data : data);
        return {kind:dirty?'dirty':'synced'};
      } finally { busy = false; }
    }
    return {sync, get busy() {return busy;}};
  }

  function createRemote({request, validatePayload}) {
    async function json(response) {
      const text = await response.text();
      if (new TextEncoder().encode(text).length > MAX_BYTES) throw new SyncError('format', 'Driveデータが大きすぎるため同期を停止しました。');
      try { return JSON.parse(text); } catch { throw new SyncError('format', 'Driveから正しいJSONを取得できませんでした。データなしとは扱いません。'); }
    }
    async function read() {
      const query = new URLSearchParams({spaces:'appDataFolder',q:`name = '${FILE_NAME}' and trashed = false`,fields:'nextPageToken,incompleteSearch,files(id,name,mimeType)',pageSize:'100'});
      const files = [], pages = new Set();
      do {
        const result = await json(await request(API+'?'+query));
        if (!isObject(result) || !Array.isArray(result.files) || (result.incompleteSearch !== undefined && result.incompleteSearch !== false) || (result.nextPageToken !== undefined && typeof result.nextPageToken !== 'string')) throw new SyncError('format', 'Driveの検索結果を確認できませんでした。同期を停止しました。');
        files.push(...result.files);
        if (files.length > 1) throw new SyncError('duplicate', 'Driveに同名の同期ファイルが複数あります。自動選択・上書きせず停止しました。');
        if (!result.nextPageToken) break;
        if (pages.has(result.nextPageToken) || pages.size >= 100) throw new SyncError('format', 'Driveの検索を完了できませんでした。');
        pages.add(result.nextPageToken);query.set('pageToken',result.nextPageToken);
      } while (true);
      if (files.length === 0) return null; // Only a successful, complete list can establish absence.
      const file = files[0];
      if (!isObject(file) || typeof file.id !== 'string' || !/^[\w-]+$/.test(file.id) || file.name !== FILE_NAME || file.mimeType !== 'application/json') throw new SyncError('format', 'Drive同期ファイルの種類が正しくありません。');
      // Obtain a resource ETag, bracket media read with metadata to detect changes.
      const resourceURL = API+'/'+encodeURIComponent(file.id)+'?fields=id,version';
      const metaResponse = await request(resourceURL), metadata = await json(metaResponse);
      if (metadata.id !== file.id || typeof metadata.version !== 'string') throw new SyncError('format', 'Driveファイルの更新情報を確認できません。');
      const body = await json(await request(API+'/'+encodeURIComponent(file.id)+'?alt=media'));
      const envelope = await validateEnvelope(body,validatePayload);
      const after = await json(await request(resourceURL));
      if (after.id !== file.id || after.version !== metadata.version) throw new SyncError('changed', '読み込み中にDriveのデータが変わりました。もう一度同期してください。');
      return {id:file.id,envelope,revision:metadata.version,etag:metaResponse.headers.get('ETag')};
    }
    async function write(current,envelope) {
      const body = JSON.stringify(envelope);
      if (new TextEncoder().encode(body).length > MAX_BYTES) throw new SyncError('format', '同期データが10MBを超えるため送信を停止しました。');
      if (current) {
        // Never fall back to an unconditional overwrite if the browser cannot read ETag.
        if (!current.etag || !/^"[^\r\n]+"$/.test(current.etag)) throw new SyncError('guard', 'Driveの上書き保護情報を取得できません。安全のため送信を停止しました。端末保存とJSONバックアップは使えます。');
        await request(UPLOAD+'/'+encodeURIComponent(current.id)+'?uploadType=media', {method:'PATCH',headers:{'Content-Type':'application/json; charset=UTF-8','If-Match':current.etag},body});
      } else {
        const boundary = 'mrh_'+crypto.randomUUID().replaceAll('-','');
        const metadata = {name:FILE_NAME,mimeType:'application/json',parents:['appDataFolder']};
        const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
        await request(UPLOAD+'?uploadType=multipart&fields=id', {method:'POST',headers:{'Content-Type':'multipart/related; boundary='+boundary},body:multipart});
      }
    }
    return {read,write};
  }

  function mount(bridge) {
    const $ = id => document.getElementById(id);
    const clientId = window.MRH_CONFIG?.GOOGLE_CLIENT_ID?.trim() || '';
    let meta = defaultMeta(), metaBroken = false;
    let token = '', expiresAt = 0, epoch = 0, runEpoch = 0, debounceTimer, expiryTimer, loading = false, authenticating = false, paused = false;
    let aborters = new Set(), dialogCancel = null;
    try {
      const stored=localStorage.getItem(META_KEY);
      if (stored) {
        const raw=JSON.parse(stored);
        if (!isObject(raw) || Object.keys(defaultMeta()).some(k=>raw[k] !== undefined && typeof raw[k] !== 'string')) throw new Error();
        meta=Object.fromEntries(Object.keys(defaultMeta()).map(k=>[k,raw[k] || '']));
        if (meta.clientId !== clientId) meta=defaultMeta(); // Different OAuth app must establish a new baseline.
      }
    } catch {metaBroken=true;}
    function status(kind,message) {
      $('drive-status').dataset.state=kind;$('drive-status').textContent=message;
      $('drive-last-sync').textContent='最終同期：'+(meta.lastSyncAt?displayTime(meta.lastSyncAt):'まだありません');
    }
    function saveMeta(next) {
      if (metaBroken) throw new SyncError('storage','同期管理情報を読み込めません。「接続を解除」してから接続し直してください。記録は保持されます。');
      const safe=Object.fromEntries(Object.keys(defaultMeta()).map(k=>[k,next[k] || '']));safe.clientId=clientId;
      try {localStorage.setItem(META_KEY,JSON.stringify(safe));} catch {throw new SyncError('storage','端末の記録は保持していますが、同期状態を保存できませんでした。空き容量を確認してください。');}
      meta=safe;
    }
    function displayTime(value) {const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('ja-JP'):'不明';}
    function validToken() {return Boolean(token && Date.now()<expiresAt);}
    function assertSession() {
      if(runEpoch!==epoch)throw new SyncError('cancelled','接続が解除されたため同期を停止しました。');
      if(!navigator.onLine)throw new SyncError('offline','オフラインです。端末内に保存し、Drive同期は未完了です。');
      if(!validToken())throw new SyncError('auth','Google Driveへの再接続が必要です。端末データは保持しています。');
    }
    async function request(url,options={}) {
      assertSession();
      const controller=new AbortController();aborters.add(controller);
      const timeout=setTimeout(()=>controller.abort(),20000);
      try {
        const response=await fetch(url,{...options,headers:{...options.headers,Authorization:'Bearer '+token},credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
        assertSession();
        if(response.status===401){token='';expiresAt=0;throw new SyncError('auth','認証期限が切れたか無効になりました。Google Driveへの再接続が必要です。');}
        if(response.status===403)throw new SyncError('api','Driveへのアクセスが許可されませんでした。権限・API設定・利用上限を確認してください。データなしとは扱いません。');
        if(response.status===412)throw new SyncError('changed','送信直前にDriveが更新されました。上書きを中止しました。もう一度同期してください。');
        if(!response.ok)throw new SyncError('api',`Drive APIエラー（${response.status}）のため同期できません。端末保存は維持しています。`);
        // Read inside the timeout so a stalled response body cannot hold sync open forever.
        const text=await response.text();assertSession();
        return {headers:response.headers,text:async()=>text};
      } catch(error) {
        if(error instanceof SyncError)throw error;
        assertSession();
        throw new SyncError('network','Driveと通信できませんでした。端末保存は成功していますが、Drive同期は未完了です。');
      } finally {clearTimeout(timeout);aborters.delete(controller);}
    }
    function readSafety() {
      const raw=localStorage.getItem(SAFETY_KEY);
      if(!raw)return [];
      const values=JSON.parse(raw);
      if(!Array.isArray(values) || values.some(v=>!isObject(v) || typeof v.createdAt!=='string' || !isObject(v.backup))) throw new Error();
      return values;
    }
    function renderSafety() {
      const select=$('drive-safety-select');select.replaceChildren();
      try {
        const copies=readSafety();
        copies.forEach((copy,index)=>{const opt=document.createElement('option');opt.value=String(index);opt.textContent=`${displayTime(copy.createdAt)} · ${copy.source}`;select.append(opt);});
        if(copies.length)select.value=String(copies.length-1);
        $('drive-safety-count').textContent=`安全コピー：${copies.length}件（この端末内のみ）`;
        $('drive-safety-export').disabled=!copies.length;
      } catch {$('drive-safety-count').textContent='安全コピーを読み込めません。削除せず確認してください。';$('drive-safety-export').disabled=true;}
    }
    function saveSafety(source,backup) {
      try {
        const copies=readSafety();
        if(copies.some(v=>canonicalJSON(v.backup)===canonicalJSON(backup)))return;
        if(copies.length>=20)throw new Error();
        copies.push({createdAt:new Date().toISOString(),source,backup});
        localStorage.setItem(SAFETY_KEY,JSON.stringify(copies));renderSafety();
      } catch {throw new SyncError('safety','上書き前の安全コピーを保存できません。同期を停止しました。安全コピーを書き出して整理し、空き容量を確認してください（最大20件）。');}
    }
    function downloadJSON(data,name) {
      const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    }
    $('drive-safety-export').addEventListener('click',()=>{try {const copy=readSafety()[Number($('drive-safety-select').value)];if(copy)downloadJSON(copy.backup,'morning-report-safety-'+Date.now()+'.json');}catch{status('error','安全コピーを書き出せませんでした。記録は変更していません。');}});
    $('drive-safety-clear').addEventListener('click',()=>{if(engine.busy)return;if(confirm('必要な安全コピーを書き出しましたか？安全コピーだけを削除します。現在の記録・Driveデータは残ります。') && confirm('安全コピーをすべて削除してよいですか？')){try{localStorage.removeItem(SAFETY_KEY);renderSafety();}catch{status('error','安全コピーを削除できませんでした。');}}});
    function askConflict(info) {
      return new Promise(resolve=>{
        const dialog=$('drive-conflict');
        $('drive-conflict-title').textContent=info.initial?'初回接続：端末とDriveの内容が異なります':'端末とGoogle Driveの両方に変更があります';
        $('drive-conflict-detail').textContent=`端末側：${info.localCount}件\nDrive側：${info.remoteCount}件\nDrive側の最終更新：${displayTime(info.updatedAt)}\n最後の正常同期：${info.lastSyncAt?displayTime(info.lastSyncAt):'まだありません'}\n\n選んだ側の記録・固定依頼文を全体として採用します。日付ごとの自動結合はしません。端末の下書きは保持します。`;
        function finish(result){dialog.close();dialogCancel=null;resolve(result);}
        dialogCancel=()=>finish('cancel');
        $('drive-use-local').onclick=()=>{if(confirm('この端末の記録・設定でDriveを上書きしますか？Drive側の上書き前データは安全コピーとして端末内に保存します。'))finish('upload');};
        $('drive-use-remote').onclick=()=>{if(confirm('Driveの記録・設定で端末を上書きしますか？端末側の上書き前データは安全コピーとして残し、下書きも保持します。'))finish('download');};
        $('drive-conflict-cancel').onclick=()=>finish('cancel');dialog.oncancel=e=>{e.preventDefault();finish('cancel');};dialog.showModal();
      });
    }
    const remote=createRemote({request,validatePayload:bridge.validateSyncPayload});
    const engine=createEngine({bridge,remote,readMeta:()=>meta,writeMeta:saveMeta,saveSafety,assertSession,notify:status,
      askInitial:count=>confirm(`Google Driveにはまだデータがありません。\nこの端末には${count}件の記録があります。\n現在の端末データ（記録・固定依頼文）をGoogle Driveへ初回バックアップしますか？\n入力途中の下書きは送信しません。`),askConflict});
    function refreshButtons(){for(const id of ['drive-connect','drive-now'])$(id).disabled=engine.busy || authenticating || loading;}
    async function sync(manual=false) {
      if(engine.busy)return;
      if(!manual && paused)return;
      if(metaBroken){status('error','同期管理情報を読み込めません。「接続を解除」してから接続し直してください。');return;}
      if(!navigator.onLine){status('offline','オフラインです。端末内保存は使えます。Drive同期は未完了です。');return;}
      if(!validToken()){status('auth','未同期・Drive再接続が必要です。「接続」または「今すぐ同期」を押してください。');return;}
      clearTimeout(debounceTimer);runEpoch=epoch;
      const thisEpoch=epoch;
      try {
        const promise=engine.sync();refreshButtons();const result=await promise;
        if(thisEpoch!==epoch)return;
        if(result.kind==='synced'){paused=false;status('synced','同期済みです。端末とDriveの記録・設定が一致しています。');}
        else if(result.kind==='dirty'){status('dirty','端末保存済み・未同期の変更があります。');schedule();}
        else if(result.kind==='cancelled'){paused=true;status('paused','同期をキャンセルしました。双方のデータを保持しています。再開は「今すぐ同期」を押してください。');}
      } catch(error) {
        if(thisEpoch!==epoch)return;
        // Transient failures retry on a later local edit or online event, never in a retry loop.
        paused=!['network','api','offline','auth'].includes(error.code);
        status(error.code==='auth'?'auth':error.code==='offline'?'offline':error.code==='changed'?'conflict':'error',error instanceof SyncError?error.message:'端末データを安全に読み書きできないため同期を停止しました。記録を確認し、ページを再読み込みしてください。');
      } finally {refreshButtons();}
    }
    function schedule(){clearTimeout(debounceTimer);if(validToken() && navigator.onLine && !paused)debounceTimer=setTimeout(()=>sync(),3000);}
    function onLocalSyncableChange() {
      try{saveMeta({...meta,localModifiedAt:new Date().toISOString()});}catch(error){status('error',error.message);return;}
      if(!clientId){status('unconfigured','未接続：Client IDが未設定です。端末内保存は成功しています。');return;}
      if(!navigator.onLine)status('offline','オフライン・未同期です。端末内への保存は成功しています。');
      else if(!validToken())status('auth','端末保存済み・未同期です。Google Driveへの再接続が必要です。');
      else if(paused)status('paused','端末保存済み・同期停止中です。「今すぐ同期」で比較し直してください。');
      else {status('dirty','端末保存済み・未同期です。まもなくDriveと比較します。');schedule();}
    }
    function disconnect() {
      epoch++;token='';expiresAt=0;authenticating=false;paused=true;
      clearTimeout(debounceTimer);clearTimeout(expiryTimer);aborters.forEach(c=>c.abort());dialogCancel?.();
      // Local disconnection only. Google revocation can remove appData; do not call revoke().
      try{localStorage.removeItem(META_KEY);meta=defaultMeta();metaBroken=false;}catch{metaBroken=true;}
      status('disconnected','未接続です。端末・Driveの記録は削除していません。');refreshButtons();
    }
    function userConnect() {
      if(engine.busy || authenticating || loading)return;
      if(!clientId){status('unconfigured','Client IDが未設定です。config.jsのGOOGLE_CLIENT_IDを設定するまでは端末内で使えます。');return;}
      if(metaBroken){status('error','同期管理情報を読み込めません。まず「接続を解除」を押してください。');return;}
      if(!window.isSecureContext || !/^https?:$/.test(location.protocol)){status('error','Google接続はHTTPSの公開URLから利用してください。端末内保存は引き続き使えます。');return;}
      if(!navigator.onLine){status('offline','オフラインです。通信が戻ってから接続してください。');return;}
      paused=false;
      if(validToken()){void sync(true);return;}
      if(!window.google?.accounts?.oauth2){
        // Load only following an explicit click; never cache GIS, never load it unconfigured.
        loading=true;refreshButtons();status('connecting','Google認証の準備中です。記録はまだ送信していません。');
        const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;
        const loadEpoch=epoch;
        const timer=setTimeout(()=>finish(false),15000);
        function finish(ok){if(!loading)return;loading=false;clearTimeout(timer);script.onload=script.onerror=null;if(!ok)script.remove();refreshButtons();if(loadEpoch!==epoch)return;status(ok?'ready':'error',ok?'認証の準備ができました。もう一度「Google Driveに接続」または「今すぐ同期」を押してください。':'Google認証を読み込めませんでした。端末内保存は使えます。');}
        script.onload=()=>finish(Boolean(window.google?.accounts?.oauth2));script.onerror=()=>finish(false);document.head.append(script);return;
      }
      const authEpoch=++epoch;authenticating=true;refreshButtons();status('connecting','Googleの画面でアプリ専用データへのアクセスを許可してください。');
      try {
        const client=google.accounts.oauth2.initTokenClient({client_id:clientId,scope:SCOPE,include_granted_scopes:false,
          callback:response=>{
            if(authEpoch!==epoch)return;
            authenticating=false;refreshButtons();
            if(response.error){status('denied',response.error==='access_denied'?'認証が拒否されました。端末の記録はそのまま使えます。':'Google認証に失敗しました。接続設定を確認してください。');return;}
            if(typeof response.access_token!=='string' || !Number.isFinite(Number(response.expires_in)) || Number(response.expires_in)<=30 ||
                typeof response.scope!=='string' || !response.scope.split(/\s+/).includes(SCOPE)) {status('denied','必要な権限または有効な認証を確認できません。端末データは送信していません。');return;}
            token=response.access_token;expiresAt=Date.now()+Number(response.expires_in)*1000-30000;
            clearTimeout(expiryTimer);expiryTimer=setTimeout(()=>{token='';expiresAt=0;status('auth','Google Driveへの再接続が必要です。端末内保存は使えます。');},Math.min(expiresAt-Date.now(),2147483647));
            status('connected','接続済みです。Driveと端末を比較します。');void sync(true);
          },error_callback:()=>{if(authEpoch!==epoch)return;authenticating=false;refreshButtons();status('denied','Google認証画面を開けないか、認証が中止されました。ポップアップ許可を確認して再度接続してください。');}});
        // Called directly from a button event; never from an online event or timer.
        client.requestAccessToken({prompt:'select_account'});
      } catch {authenticating=false;refreshButtons();status('error','Google認証を開始できませんでした。設定とポップアップ許可を確認してください。');}
    }
    $('drive-connect').addEventListener('click',userConnect);$('drive-now').addEventListener('click',userConnect);$('drive-disconnect').addEventListener('click',disconnect);
    window.addEventListener('online',()=>{if(!clientId){status('unconfigured','未接続：Client IDは未設定です。端末内保存は使えます。');}else if(validToken()){paused=false;void sync();}else status('auth','未同期・Drive再接続が必要です。接続ボタンを押してください。');});
    window.addEventListener('offline',()=>{clearTimeout(debounceTimer);status('offline','オフラインです。記録は端末内に保存できます。');});
    window.addEventListener('storage',event=>{if(event.key===META_KEY || event.key==='morning-report-hub.v1' || event.key===null){epoch++;token='';expiresAt=0;authenticating=false;paused=true;clearTimeout(expiryTimer);aborters.forEach(c=>c.abort());dialogCancel?.();refreshButtons();status('paused','別のタブで保存状態が変わりました。同期を停止しています。再読み込みしてください。');}});
    renderSafety();status(metaBroken?'error':clientId?'disconnected':'unconfigured',metaBroken?'同期管理情報を読み込めません。端末内の記録は変更していません。':clientId?'未接続です。「Google Driveに接続」で開始できます。':'未接続：Client IDは未設定です。従来どおり端末内で使えます。');
    if(!navigator.onLine)status('offline','オフラインです。端末内保存は使えます。Drive同期は接続後に利用できます。');
    return {onLocalSyncableChange,disconnect};
  }
  const exports={canonicalJSON,contentHash,decideSync,validateEnvelope,createEngine,createRemote,mount,SyncError,META_KEY,SAFETY_KEY,SCOPE};
  if(typeof module!=='undefined' && module.exports)module.exports=exports;
  if(typeof window!=='undefined')window.MRHDrive=Object.freeze(exports);
})();
