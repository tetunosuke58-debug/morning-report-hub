/* Morning Report Hub — external dependencies / network requests: none. */
(() => {
  'use strict';
  const KEY = 'morning-report-hub.v1';
  const MUSCLES = { chest: '胸', shoulder: '肩', arm: '腕', back: '背中', abs: '腹筋', legs: '脚', glutes: '尻' };
  const CHOICES = {
    quality: ['1','2','3','4','5'], fatigue: ['0','1','2','3','4','5'], health: ['良好','普通','不調'], appetite: ['普通','少ない','なし'], alcohol: ['なし','あり'],
    pain: ['なし','あり'], backDiscomfort: ['なし','あり'], trainingTime: ['朝','昼','夕方','夜'], breakfast: ['食べる','食べない'], lunch: ['同僚と外食','外回りで外食','事務所食','その他'], dinner: ['家族と通常夕食','会食','外食','その他'], dinnerAlcohol: ['あり','なし'], hunger: ['はい','いいえ'], snack: ['高い','低い']
  };
  const NUMBERS = {
    weight: [1,500,0.01,'体重'], sleepH: [0,24,1,'主睡眠の時間'], sleepM: [0,59,1,'主睡眠の分'], extraH: [0,24,1,'追加睡眠の時間'], extraM: [0,59,1,'追加睡眠の分'], drinks: [0.5,100,0.5,'杯数'], painLevel: [0,10,1,'痛み'], backLevel: [0,10,1,'腰の違和感'], trainingMinutes: [0,1440,1,'トレーニング可能時間'],
    ...Object.fromEntries(Object.entries(MUSCLES).map(([k,v]) => [k,[0,10,1,v+'の筋肉痛']]))
  };
  const TEXTS = { otherHealth:3000, painPlace:200, backAction:200, backPlace:200, trainingNote:3000, breakfastText:3000, lunchText:3000, dinnerText:3000 };
  const FIELDS = ['date', ...Object.keys(NUMBERS), ...Object.keys(CHOICES), ...Object.keys(TEXTS), 'leaveTime', 'dinnerTime'];
  const has = v => v !== '' && v !== undefined && v !== null;
  const emptyDB = () => ({version:1, records:{}, settings:{coachRequest:'', foodRequest:''}, draft:null, draftDay:''});
  const pad = n => String(n).padStart(2,'0');
  function dateKey(date = new Date()) { return `${date.getFullYear()}/${pad(date.getMonth()+1)}/${pad(date.getDate())}`; }
  function parseDate(value) {
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(value || '')) return null;
    const [y,m,d] = value.split('/').map(Number);
    const dt = new Date(y,m-1,d,12);
    return y >= 1900 && y <= 2100 && dateKey(dt) === value ? dt : null;
  }
  function addDays(date, days) { const result = new Date(date); result.setDate(result.getDate()+days); return result; }
  function cleanRecord(raw, requireWeight = false, draft = false) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('記録の形式が正しくありません。');
    const r = Object.fromEntries(FIELDS.map(k => [k, '']));
    for (const key of FIELDS) {
      const v = raw[key];
      if (v === undefined) continue;
      if (typeof v !== 'string' || v.length > (TEXTS[key] || 200)) throw new Error('記録の値が正しくありません。');
      r[key] = v.trim();
    }
    if (draft) return r; // Draft may contain unfinished input; validate before saving as a record.
    if (!parseDate(r.date)) throw new Error('日付をYYYY/MM/DD形式で入力してください（1900〜2100年）。');
    if (requireWeight && !has(r.weight)) throw new Error('体重を入力してから保存・レポート生成してください。');
    if (r.alcohol !== 'あり') r.drinks = '';
    if (r.pain !== 'あり') r.painPlace = r.painLevel = '';
    if (r.backDiscomfort !== 'あり') r.backAction = r.backPlace = r.backLevel = '';
    if (r.dinner !== '会食') r.dinnerAlcohol = '';
    for (const [k,[min,max,step,label]] of Object.entries(NUMBERS)) {
      if (!has(r[k])) continue;
      const n = Number(r[k]);
      if (!/^\d+(?:\.\d+)?$/.test(r[k]) || !Number.isFinite(n) || n < min || n > max || Math.abs(n/step-Math.round(n/step)) > 0.000001 || (k === 'weight' && (r[k].split('.')[1] || '').length > 2)) throw new Error(`${label}は${min}〜${max}の範囲で、${step === 1 ? '整数' : step === 0.01 ? '小数第2位まで' : '0.5刻み'}で入力してください。`);
    }
    for (const [k, options] of Object.entries(CHOICES)) if (has(r[k]) && !options.includes(r[k])) throw new Error('選択項目の値が正しくありません。');
    for (const k of ['leaveTime','dinnerTime']) if (has(r[k]) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r[k])) throw new Error('時刻を正しく入力してください。');
    const main = has(r.sleepH) || has(r.sleepM), extra = has(r.extraH) || has(r.extraM);
    if (extra && !main) throw new Error('追加睡眠を入力する場合は、主睡眠も入力してください。');
    if (sleepMinutes(r,'sleep') + sleepMinutes(r,'extra') > 1440) throw new Error('睡眠時間の合計は24時間以内で入力してください。');
    return r;
  }
  function sleepMinutes(r, prefix) { return Number(r[prefix+'H'] || 0)*60 + Number(r[prefix+'M'] || 0); }
  function duration(n) { return n === 0 ? '0分' : `${Math.floor(n/60) ? Math.floor(n/60)+'時間' : ''}${n%60 ? n%60+'分' : ''}`; }
  function sleepText(r) {
    if (!has(r.sleepH) && !has(r.sleepM)) return '';
    const a = sleepMinutes(r,'sleep'), b = sleepMinutes(r,'extra');
    return has(r.extraH) || has(r.extraM) ? `${duration(a)}＋${duration(b)}＝計${duration(a+b)}` : duration(a);
  }
  function weekStats(records, selectedDate) {
    const dt = parseDate(selectedDate);
    if (!dt) return [];
    const monday = addDays(dt, -((dt.getDay()+6)%7));
    return [0,1,2].map(offset => {
      const start = dateKey(addDays(monday,-7*offset));
      const end = offset === 0 ? selectedDate : dateKey(addDays(monday, -7*offset+6));
      const entries = Object.entries(records).filter(([d,r]) => d >= start && d <= end && has(r.weight)).sort(([a],[b])=>a.localeCompare(b));
      const total = entries.reduce((sum,[,r])=>sum+Math.round(Number(r.weight)*100),0);
      return {start,end,entries,count:entries.length,average:entries.length ? (Math.round(total/entries.length)/100).toFixed(2) : null};
    });
  }
  function bodyLines(r) {
    const lines = [];
    const put = (label,value) => { if(has(value)) lines.push(`・${label}：${value}`); };
    put('体重', has(r.weight) ? Number(r.weight).toFixed(2)+'kg' : '');
    put('睡眠',sleepText(r)); put('睡眠の質',has(r.quality)?r.quality+'/5':''); put('疲労',has(r.fatigue)?r.fatigue+'/5':'');
    put('体調',r.health); put('食欲',r.appetite); put('前日の飲酒',r.alcohol === 'あり' && has(r.drinks) ? `あり（${r.drinks}杯）` : r.alcohol); put('その他の体調',r.otherHealth);
    return lines;
  }
  function painLines(r) {
    const lines = [], entries = Object.entries(MUSCLES), zeros = entries.filter(([k])=>has(r[k]) && Number(r[k])===0), positives = entries.filter(([k])=>has(r[k]) && Number(r[k])>0);
    if (zeros.length === entries.length) lines.push('・筋肉痛：なし');
    else {
      positives.forEach(([k,label]) => lines.push(`・${label}：筋肉痛${r[k]}/10`));
      if (zeros.length) lines.push(`・${zeros.length + positives.length === entries.length ? 'その他' : zeros.map(([,label])=>label).join('・')}：0/10`);
    }
    if (has(r.pain)) lines.push(`・その他の痛み：${r.pain}${r.pain === 'あり' ? [r.painPlace,has(r.painLevel)?r.painLevel+'/10':''].filter(has).map(v=>'／'+v).join('') : ''}`);
    if (has(r.backDiscomfort)) lines.push(`・腰の違和感：${r.backDiscomfort}${r.backDiscomfort === 'あり' ? [r.backAction,r.backPlace,has(r.backLevel)?r.backLevel+'/10':''].filter(has).map(v=>'／'+v).join('') : ''}`);
    return lines;
  }
  function planLines(r, note = true) {
    return [has(r.trainingMinutes)?`・本日のトレーニング可能時間：${r.trainingMinutes}分`:'',has(r.trainingTime)?`・予定時間帯：${r.trainingTime}`:'',note && has(r.trainingNote)?`・特記事項：${r.trainingNote}`:''].filter(has);
  }
  function mealLines(r) {
    const result = [];
    for (const [k,label] of [['breakfast','朝食'],['lunch','昼食'],['dinner','夕食']]) {
      const parts = [r[k],r[k+'Text']].filter(has);
      if(parts.length) result.push(`・${label}：${parts.join('／')}`);
    }
    for (const [label,value] of [['会食での飲酒予定',r.dinner==='会食'?r.dinnerAlcohol:''],['退社予定時刻',r.leaveTime],['夕食予定時刻',r.dinnerTime],['夕方に空腹になりそう',r.hunger],['帰宅途中に買い食いする可能性',r.snack]]) if(has(value)) result.push(`・${label}：${value}`);
    return result;
  }
  function weightLines(stats) {
    const trend = stats[0].entries.map(([d,r])=>`・${Number(d.slice(5,7))}/${Number(d.slice(8,10))}：${Number(r.weight).toFixed(2)}kg`);
    return ['【今週の体重推移（選択日まで）】',...(trend.length?trend:['データなし']), '', ...stats.map((w,i)=>`・${['今週の暫定平均','先週の平均','前々週の平均'][i]}：${w.count ? `${w.average}kg（${w.count}日平均）` : 'データなし'}`)];
  }
  function generateReports(r, records, settings) {
    const stats = weekStats(records,r.date), basics = bodyLines(r), pains = painLines(r), meals = mealLines(r);
    const section = (title,lines) => lines.length ? ['',`【${title}】`,...lines] : [];
    const log = [`${r.date} 体重・体調ログ`,...basics,...pains,...section('今日の予定',planLines(r)),...section('食事予定',meals)];
    const coach = [`${r.date} 朝の報告（コーチChat）`,...basics,...pains,'',...weightLines(stats),...section('今日の予定',planLines(r)),'','本日の体調・睡眠・疲労・筋肉痛等を踏まえ、トレーニングを行うかも含めて判断してください。'];
    const food = [`${r.date} 朝の報告（食事管理Chat）`,...basics,'',...weightLines(stats),...section('食事予定',meals),...section('今日のトレーニング予定',planLines(r,false))];
    // "Enough history": at least three recorded days in each of two of these weeks.
    if (stats.filter(w=>w.count>=3).length>=2) food.push('','単日の体重だけで食事方針を変更せず、週平均の推移も踏まえて判断してください。');
    if (settings.coachRequest.trim()) coach.push('',settings.coachRequest.trim());
    if (settings.foodRequest.trim()) food.push('',settings.foodRequest.trim());
    return {log:log.join('\n'),coach:coach.join('\n'),food:food.join('\n')};
  }
  function validateBackup(raw) {
    if (!raw || raw.version !== 1 || !raw.records || typeof raw.records !== 'object' || Array.isArray(raw.records) || !raw.settings || typeof raw.settings !== 'object') throw new Error('対応するMorning Report Hubのバックアップではありません。');
    const next = emptyDB(), entries = Object.entries(raw.records);
    if (entries.length > 50000) throw new Error('記録件数が多すぎます。');
    for (const [date,r] of entries) {
      const clean = cleanRecord(r,true);
      if (clean.date !== date) throw new Error('記録の日付が一致していません。');
      next.records[date] = clean;
    }
    for (const key of ['coachRequest','foodRequest']) {
      if (typeof raw.settings[key] !== 'string' || raw.settings[key].length > 10000) throw new Error('固定依頼文の形式が正しくありません。');
      next.settings[key] = raw.settings[key];
    }
    if(raw.draft !== null && raw.draft !== undefined) next.draft = cleanRecord(raw.draft,false,true);
    if(raw.draftDay !== undefined && (typeof raw.draftDay !== 'string' || (raw.draftDay !== '' && !parseDate(raw.draftDay)))) throw new Error('入力途中の保存日の形式が正しくありません。');
    next.draftDay = raw.draftDay || '';
    return next;
  }
  // Data and text functions can be tested without a browser or persistent records.
  if (typeof module !== 'undefined' && module.exports) module.exports = {cleanRecord,dateKey,parseDate,sleepText,weekStats,generateReports,validateBackup,emptyDB};
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id), form = $('morning-form');
  let db = emptyDB(), storageBlocked = false, toastTimer;
  function notify(message) { $('notice').textContent = message; $('notice').hidden = false; $('notice').scrollIntoView({block:'nearest'}); }
  function toast(message) { $('toast').textContent=message; $('toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').hidden=true,2600); }
  function commit(next) {
    if(storageBlocked) throw new Error('保存済みデータを読み込めないため上書きを停止しています。設定から有効なバックアップを復元するか、全削除してください。');
    try { localStorage.setItem(KEY,JSON.stringify(next)); } catch { throw new Error('保存できませんでした。ブラウザの保存許可・空き容量を確認してください。入力は画面に残っています。'); }
    db = next;
  }
  try { const raw=localStorage.getItem(KEY); if(raw) db=validateBackup(JSON.parse(raw)); }
  catch { storageBlocked=true; notify('保存データを読み込めませんでした。既存データを保護するため上書きを停止しました。バックアップの復元、または設定の全削除を利用してください。'); }
  function choice(target,key,label,hint='') {
    const fieldset=document.createElement('fieldset'), legend=document.createElement('legend'), hidden=document.createElement('input'), buttons=document.createElement('div');
    legend.textContent=label; hidden.type='hidden'; hidden.name=key; buttons.className='choices'+(['quality','fatigue'].includes(key)?' numbered'+(key==='quality'?' five':''):'');
    CHOICES[key].forEach(value=> { const button=document.createElement('button'); button.type='button'; button.textContent=value; button.dataset.choice=key; button.dataset.value=value; button.setAttribute('aria-pressed','false'); button.addEventListener('click',()=> { hidden.value=hidden.value===value?'':value; conditionalClear(key); changed(); }); buttons.append(button); });
    fieldset.append(legend,hidden,buttons);
    if(hint) {const p=document.createElement('p');p.className='hint';p.textContent=hint;fieldset.append(p);}
    $(target).append(fieldset);
  }
  choice('basic-choices','quality','睡眠の質','1：悪い → 5：良い');
  choice('basic-choices','fatigue','疲労度','0：疲労なし · 1：ごく軽い · 2：軽い · 3：中程度 · 4：強い · 5：非常に強い');
  choice('basic-choices','health','体調'); choice('basic-choices','appetite','食欲'); choice('basic-choices','alcohol','前日の飲酒');
  choice('pain-choices','pain','その他の痛み'); choice('back-choices','backDiscomfort','腰の違和感'); choice('time-choices','trainingTime','予定時間帯');
  choice('breakfast-choices','breakfast','朝食'); choice('lunch-choices','lunch','昼食'); choice('dinner-choices','dinner','夕食'); choice('dinner-alcohol-choices','dinnerAlcohol','会食での飲酒予定'); choice('hunger-choices','hunger','夕方に空腹になりそう'); choice('snack-choices','snack','帰宅途中に買い食いする可能性');
  for (const [key,label] of Object.entries(MUSCLES)) {
    const wrapper=document.createElement('label'),select=document.createElement('select'); wrapper.textContent=label;select.name=key;
    for (const value of ['',...Array.from({length:11},(_,i)=>String(i))]) { const option=document.createElement('option'); option.value=value;option.textContent=value===''?'未選択':value;select.append(option); }
    wrapper.append(select);$('muscles').append(wrapper);
  }
  const value = key => form.elements.namedItem(key).value;
  const set = (key,v) => {form.elements.namedItem(key).value=v;};
  const readForm = () => Object.fromEntries(FIELDS.map(k=>[k,value(k)]));
  function fillForm(r) { for(const k of FIELDS) set(k,r?.[k] || (k==='date'?dateKey():'')); syncUI(); }
  function conditionalClear(k) {
    if(k==='alcohol' && value(k)!=='あり') set('drinks','');
    if(k==='pain' && value(k)!=='あり') ['painPlace','painLevel'].forEach(k=>set(k,''));
    if(k==='backDiscomfort' && value(k)!=='あり') ['backAction','backPlace','backLevel'].forEach(k=>set(k,''));
    if(k==='dinner' && value(k)!=='会食') set('dinnerAlcohol','');
  }
  function syncUI() {
    document.querySelectorAll('[data-choice]').forEach(b=>b.setAttribute('aria-pressed',String(value(b.dataset.choice)===b.dataset.value)));
    for(const [id,key,expected] of [['alcohol-detail','alcohol','あり'],['pain-detail','pain','あり'],['back-detail','backDiscomfort','あり'],['dinner-alcohol-choices','dinner','会食']]) {
      $(id).hidden=value(key)!==expected;
      $(id).querySelectorAll('input,button').forEach(el=>el.disabled=$(id).hidden);
    }
    const r=readForm(), nums=['sleepH','sleepM','extraH','extraM'];
    $('sleep-total').textContent=nums.every(k=>!has(r[k]) || (Number.isFinite(Number(r[k])) && Number(r[k])>=0 && Number(r[k])<= (k.endsWith('M')?59:24))) && sleepMinutes(r,'sleep')+sleepMinutes(r,'extra')<=1440 ? sleepText(r) : '';
    const exists=Boolean(db.records[value('date')]);
    $('record-state').textContent=exists?'この日付の記録があります。読み込むか、現在の入力で更新できます。':'日付を変えても、入力中の内容はそのままです。';
    $('load-day').hidden=!exists;
    $('resume-draft').hidden=!db.draft || db.draftDay===dateKey();
  }
  function invalidate() { $('results').hidden=true; $('report-cards').replaceChildren(); }
  function saveDraft() {
    try {commit({...db,draft:readForm(),draftDay:dateKey()});$('resume-draft').hidden=true;$('draft-state').textContent='入力途中をこのブラウザに保存しました。';}
    catch(e) {$('draft-state').textContent=e.message;}
  }
  function changed() {syncUI();invalidate();saveDraft();}
  for (const el of [form.elements.date,$('history-form').elements.historyDate]) {
    el.addEventListener('input',()=>{if(/^\d{8}$/.test(el.value))el.value=el.value.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1/$2/$3');});
  }
  form.addEventListener('input',changed); form.addEventListener('change',changed);
  function checkInputs() { for(const el of form.querySelectorAll('input[type=number]')) if(!el.disabled && el.validity.badInput) throw new Error('数値欄に正しい数値を入力してください。'); return cleanRecord(readForm(),true); }
  function saveRecord(generate) {
    try {
      const r=checkInputs(), previous=db.records[r.date];
      if(previous && JSON.stringify(previous)!==JSON.stringify(r) && !confirm(`${r.date}の保存済み記録を、現在の入力内容で更新しますか？`)) return;
      commit({...db,records:{...db.records,[r.date]:r},draft:r,draftDay:dateKey()}); $('notice').hidden=true; syncUI();
      if(generate) showReports(generateReports(r,db.records,db.settings));
      toast('この日の記録を保存しました');
    } catch(e) {notify(e.message);}
  }
  form.addEventListener('submit',e=>{e.preventDefault();saveRecord(true);}); $('save-day').addEventListener('click',()=>saveRecord(false));
  function showReports(reports) {
    $('report-cards').replaceChildren();
    for(const [key,label,letter] of [['log','体重・体調ログ用','A'],['coach','コーチChat用','B'],['food','食事管理Chat用','C']]) {
      const card=document.createElement('article'),badge=document.createElement('span'),h=document.createElement('h3'),pre=document.createElement('pre'),button=document.createElement('button');
      card.className='card report-card';badge.className='report-label';badge.textContent=letter;h.textContent=label;pre.className='report-text';pre.textContent=reports[key];button.type='button';button.className='primary full';button.textContent='コピー';button.setAttribute('aria-label',label+'をコピー');button.addEventListener('click',()=>copyText(reports[key],pre));card.append(badge,h,button,pre);$('report-cards').append(card);
    }
    $('results').hidden=false;$('results-heading').focus();$('results').scrollIntoView({block:'start'});
  }
  async function copyText(text, pre) {
    try {
      if(navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else throw new Error('fallback');
      toast('コピーしました');
    } catch {
      const area=document.createElement('textarea');area.value=text;area.setAttribute('readonly','');document.body.append(area);area.focus();area.select();area.setSelectionRange(0,text.length);
      let copied=false;try{copied=document.execCommand('copy');}catch{}area.remove();
      if(copied) toast('コピーしました');
      else {const range=document.createRange();range.selectNodeContents(pre);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);notify('自動コピーが許可されませんでした。選択された文章を長押しして「コピー」を選んでください。');}
    }
  }
  function setNoSoreness() {Object.keys(MUSCLES).forEach(k=>set(k,'0'));}
  $('no-soreness').addEventListener('click',()=>{setNoSoreness();changed();});
  $('all-well').addEventListener('click',()=>{for(const [k,v] of Object.entries({health:'良好',appetite:'普通',alcohol:'なし',pain:'なし',backDiscomfort:'なし'})){set(k,v);conditionalClear(k);}setNoSoreness();changed();toast('体調系を問題なしに設定しました');});
  $('load-day').addEventListener('click',()=>loadDay(value('date')));
  $('resume-draft').addEventListener('click',()=>{if(!db.draft || !confirm('現在のフォームを前回の入力途中で置き換えますか？'))return;fillForm(db.draft);changed();});
  function loadDay(date) {if(!confirm(`${date}の保存済み記録を読み込みます。現在の入力フォームを置き換えますか？`))return;fillForm(db.records[date]);changed();switchView('morning');toast('記録を読み込みました');}
  $('clear-form').addEventListener('click',()=>{if(!confirm('入力フォームだけをクリアしますか？保存済みの記録・設定は残ります。'))return;try{commit({...db,draft:null});fillForm(null);invalidate();$('draft-state').textContent='フォームをクリアしました。保存済みの記録は残っています。';toast('フォームをクリアしました');}catch(e){notify(e.message);}});
  function deleteDay(date) {
    if(!db.records[date]) {toast('この日付の保存済み記録はありません');return;}
    if(!confirm(`${date}の記録を削除しますか？他の日付の記録は残ります。`))return;
    try {const records={...db.records};delete records[date];const clear=value('date')===date;commit({...db,records,draft:clear?null:db.draft});if(clear){fillForm({date});$('draft-state').textContent='この日の記録とフォームをクリアしました。';}invalidate();syncUI();renderHistory();toast('この日の記録を削除しました');}catch(e){notify(e.message);}
  }
  $('delete-day').addEventListener('click',()=>deleteDay(value('date')));
  function switchView(id) {
    for(const k of ['morning','history','settings']) $(k).hidden=k!==id;
    document.querySelectorAll('[data-view]').forEach(b=>{if(b.dataset.view===id)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
    if(id==='history')renderHistory();window.scrollTo(0,0);
  }
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  function renderHistory() {
    const reference=parseDate(value('date'))?value('date'):dateKey(),stats=weekStats(db.records,reference);
    $('average-reference').textContent=`朝の入力の日付 ${reference} を基準に計算（月曜〜日曜）。今週は選択日まで。`;$('averages').replaceChildren();
    stats.forEach((w,i)=>{const row=document.createElement('div'),label=document.createElement('span'),strong=document.createElement('strong');row.className='average-row';label.textContent=['今週（暫定）','先週','前々週'][i];strong.textContent=w.count?`${w.average}kg · ${w.count}日`:'データなし';row.append(label,strong);$('averages').append(row);});
    $('history-list').replaceChildren();const entries=Object.entries(db.records).sort(([a],[b])=>b.localeCompare(a));
    if(!entries.length){const p=document.createElement('p');p.className='empty';p.textContent='まだ記録がありません。';$('history-list').append(p);}
    for(const [date,r] of entries) {
      const item=document.createElement('div'),heading=document.createElement('div'),day=document.createElement('span'),weight=document.createElement('strong'),actions=document.createElement('div');item.className='history-item';heading.className='history-heading';day.textContent=date;weight.textContent=Number(r.weight).toFixed(2)+'kg';actions.className='history-actions';heading.append(day,weight);
      for(const [label,fn] of [['体重を編集',()=>{const hf=$('history-form');hf.elements.historyDate.value=date;hf.elements.historyWeight.value=r.weight;hf.elements.historyWeight.focus();hf.scrollIntoView({block:'center'});}],['朝の入力へ',()=>loadDay(date)],['削除',()=>deleteDay(date)]]) {const b=document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('aria-label',date+' '+label);if(label==='削除')b.className='danger';b.addEventListener('click',fn);actions.append(b);}item.append(heading,actions);$('history-list').append(item);
    }
  }
  $('history-form').addEventListener('submit',e=>{
    e.preventDefault();const hf=e.currentTarget,date=hf.elements.historyDate.value.trim(),weight=hf.elements.historyWeight.value;
    try {if(hf.elements.historyWeight.validity.badInput)throw new Error('体重に正しい数値を入力してください。');const r=cleanRecord({...db.records[date],date,weight},true);if(db.records[date] && !confirm(`${date}の体重を更新しますか？`))return;commit({...db,records:{...db.records,[date]:r}});invalidate();syncUI();renderHistory();hf.elements.historyWeight.value='';toast('体重を保存しました');}catch(e){notify(e.message);}
  });
  function fillSettings() {for(const key of ['coachRequest','foodRequest'])$('settings-form').elements[key].value=db.settings[key];}
  $('settings-form').addEventListener('submit',e=>{e.preventDefault();try{commit({...db,settings:{coachRequest:e.currentTarget.elements.coachRequest.value.trim(),foodRequest:e.currentTarget.elements.foodRequest.value.trim()}});invalidate();toast('固定依頼文を保存しました');}catch(e){notify(e.message);}});
  $('export').addEventListener('click',()=>{
    if(storageBlocked){notify('読み込めない保存データがあるため、通常のバックアップを書き出せません。元のブラウザデータを削除せず、有効なバックアップを確認してください。');return;}
    const blob=new Blob([JSON.stringify(db,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`morning-report-backup-${dateKey().replaceAll('/','-')}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('バックアップの保存先を確認してください');
  });
  $('import').addEventListener('change',async e=>{
    const file=e.target.files[0];if(!file)return;
    try {
      if(file.size>10*1024*1024)throw new Error('10MB以下のバックアップを選んでください。');
      const next=validateBackup(JSON.parse(await file.text())), dates=Object.keys(next.records).sort();
      const summary=`バックアップを復元しますか？\n\n記録：${dates.length}件${dates.length?'\n期間：'+dates[0]+'〜'+dates[dates.length-1]:''}\n固定依頼文：${Object.values(next.settings).filter(v=>v.trim()).length}件\n入力途中：${next.draft?'あり':'なし'}\n\n現在の${Object.keys(db.records).length}件の記録・設定・入力途中をすべて置き換えます。必要なら先に書き出してください。`;
      if(!confirm(summary))return;
      const blocked=storageBlocked;storageBlocked=false;try{commit(next);}catch(error){storageBlocked=blocked;throw error;}
      fillForm(db.draftDay===dateKey()?db.draft:null);fillSettings();invalidate();renderHistory();$('notice').hidden=true;toast('バックアップを復元しました');
    } catch(error){notify(error instanceof SyntaxError?'JSONを読み込めませんでした。正しいバックアップを選んでください。':error.message);} finally {e.target.value='';}
  });
  $('delete-all').addEventListener('click',()=>{
    if(!confirm('このアプリの全記録・設定・入力途中を削除しますか？'))return;
    if(!confirm('最終確認：削除すると元に戻せません。本当にすべて削除しますか？'))return;
    try{localStorage.removeItem(KEY);db=emptyDB();storageBlocked=false;fillForm(null);fillSettings();$('history-form').reset();$('history-form').elements.historyDate.value=dateKey();invalidate();renderHistory();$('notice').hidden=true;$('draft-state').textContent='入力途中もこのブラウザに保存されます。';toast('すべてのデータを削除しました');}catch{notify('削除できませんでした。ブラウザの保存設定を確認してください。');}
  });
  // Avoid silently overwriting changes from another open tab.
  window.addEventListener('storage',e=>{if(e.key===KEY || e.key===null){storageBlocked=true;invalidate();notify('別のタブで記録が変更されました。この画面からの保存を停止しています。ページを再読み込みしてください。');}});
  fillForm(db.draftDay===dateKey()?db.draft:null);fillSettings();$('history-form').elements.historyDate.value=dateKey();
  // Cache only the static application. Personal data never goes into requests or caches.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').then(()=>navigator.serviceWorker.ready).then(()=>{
      $('offline-state').textContent='オフライン準備完了 · 次回から通信なしで開けます';
    }).catch(()=>{$('offline-state').textContent='オフライン準備ができませんでした。通信がある状態で再度開いてください。';});
  } else if(location.protocol==='file:') $('offline-state').textContent='ローカルファイルで動作中 · このファイルの場所を変えずにご利用ください';
})();
