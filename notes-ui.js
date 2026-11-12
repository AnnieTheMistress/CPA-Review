/* Personal notes use their own storage; question progress is never edited here. */
const personalNotes = {
  store:null, opening:null, examId:null, mode:"list", draft:null, records:[], query:"",
  revision:0, saveTimer:null, savePromise:Promise.resolve(), syncTimers:new Map(), syncing:new Map(), syncAgain:new Set(),
  sequence:0, notice:"", error:false, importing:null, lastSaveError:null, lastPulled:new Map(), redirects:new Map(), sessions:new Map(), pendingWrites:0,
};

async function personalNotesStore() {
  if (personalNotes.store) return personalNotes.store;
  if (!personalNotes.opening) personalNotes.opening = ReviewNotes.createStore().then(store => (personalNotes.store=store)).catch(error => {personalNotes.opening=null;throw error;});
  return personalNotes.opening;
}
function personalNotesMessage(message,error=false) {
  personalNotes.notice=message; personalNotes.error=error;
  const target=document.querySelector("#notes-notice");
  if (target) {target.textContent=message;target.className=`notes-notice ${error?"error":""}`;}
}
function personalNotesStatus(note) {
  if (note?.syncState === "synced") return "已同步";
  if (note?.syncState === "conflict") return "已保留冲突副本 · 待同步";
  return personalNotes.store?.connection().connected ? "本地草稿 · 待同步" : "本地草稿 · 连接 GitHub 后可同步";
}
function personalNotesStatusNode(message) {
  const node=document.querySelector("#notes-edit-status");
  if (node) node.textContent=message;
}
function personalNotesTags(value) {return [...new Set(String(value||"").split(/[,，;；]+/).map(tag=>tag.trim()).filter(Boolean))];}
function personalNotesMarkdown(value) {
  // Protect escaped cell pipes before the shared renderer splits Markdown table rows.
  const protectedValue=String(value||"").replace(/\uE000/g,"\uE000e").replace(/\\\|/g,"\uE000p");
  return markdown(protectedValue).replace(/\uE000([ep])/g,(_,kind)=>kind==="e"?"\uE000":"|").replace(/&lt;br\s*\/?&gt;/gi,"<br>");
}
function personalNoteSuggestions() {
  const subjects=[...new Set(app.data.map(q=>q.subject))];
  const chapters=[...new Set(app.data.filter(q=>!personalNotes.draft?.subject||q.subject===personalNotes.draft.subject).map(q=>q.chapter))];
  return `<datalist id="notes-subjects">${subjects.map(s=>`<option value="${escapeHtml(s)}"></option>`).join("")}</datalist><datalist id="notes-chapters">${chapters.map(s=>`<option value="${escapeHtml(s)}"></option>`).join("")}</datalist>`;
}
function personalNoteRows() {
  const query=personalNotes.query.trim().toLocaleLowerCase();
  const records=personalNotes.records.filter(note=>!query||[note.title,note.body,...(note.tags||[])].join(" ").toLocaleLowerCase().includes(query));
  return records.map(note=>`<article class="personal-note-row"><button class="personal-note-open" data-notes-action="open" data-note-id="${escapeHtml(note.id)}"><strong>${escapeHtml(note.title||"未命名笔记")}</strong><span>${escapeHtml((note.body||"").replace(/\s+/g," ").slice(0,110)||"暂无正文")}</span><small>${escapeHtml([note.subject,note.chapter].filter(Boolean).join(" · "))}${note.attachments?.length?` · ${note.attachments.length} 个原文件`:""}</small><small>${escapeHtml(personalNotesStatus(note))}${note.tags?.length?` · ${escapeHtml(note.tags.join("、"))}`:""}</small></button><button class="link-button" data-notes-action="delete" data-note-id="${escapeHtml(note.id)}">删除</button></article>`).join("")||`<p class="workbench-empty">${query?"没有找到匹配的笔记。":"还没有个人笔记，可以新建或导入文件。"}</p>`;
}
function personalNoteConnection() {
  const connection=personalNotes.store.connection();
  return `<details class="workspace-card notes-connection" ${connection.connected?"":"open"}><summary>GitHub 同步 · ${connection.connected?`已连接 ${escapeHtml(connection.login||"")}`:"尚未连接"}</summary>${connection.connected?`<p>正文和原文件同步至 CPA-Study。${connection.remember?"此设备已记住连接。":"当前会话保留连接。"}</p><button class="secondary-button" data-notes-action="disconnect">断开连接</button>`:`<p>连接现有 CPA-Study 笔记仓库，电脑和手机分别连接后即可同步。未连接时仍可在此设备写笔记。</p><form id="notes-connect-form"><label for="notes-token">GitHub 授权令牌</label><input id="notes-token" class="text-input" type="password" autocomplete="off" required placeholder="仅授权 CPA-Study 仓库"><label class="notes-check"><input id="notes-remember" type="checkbox">在此设备记住连接</label><p class="notes-help"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">创建细粒度授权令牌 ↗</a>：只选择 CPA-Study 仓库，将 Contents 权限设为读写。授权令牌不会包含在笔记备份中。</p><button class="primary-button" type="submit">连接并同步</button></form>`}</details>`;
}
function personalNoteEditor() {
  const note=personalNotes.draft;
  return `<section class="workspace-card personal-note-editor"><div class="workspace-card-head"><h2>编辑笔记</h2><button class="link-button" data-notes-action="list">返回列表</button></div><form id="notes-editor-form"><label for="notes-title">标题</label><input id="notes-title" class="text-input" data-note-field="title" value="${escapeHtml(note.title)}" maxlength="200" required><div class="notes-field-grid"><label>科目<input class="text-input" list="notes-subjects" data-note-field="subject" value="${escapeHtml(note.subject||"")}" placeholder="可自行填写"></label><label>章节<input class="text-input" list="notes-chapters" data-note-field="chapter" value="${escapeHtml(note.chapter||"")}" placeholder="可自行填写"></label></div>${personalNoteSuggestions()}<label>标签<input class="text-input" data-note-field="tags" value="${escapeHtml((note.tags||[]).join("，"))}" placeholder="多个标签用逗号分隔"></label><label for="notes-body">正文</label><textarea id="notes-body" class="text-input notes-body" data-note-field="body" placeholder="写下你的理解、总结或错因，支持 Markdown">${escapeHtml(note.body||"")}</textarea><details class="notes-preview"><summary>预览正文</summary><div id="notes-preview-content">${personalNotesMarkdown(note.body||"")}</div></details><details class="notes-relations"><summary>关联错题（可选）</summary><select class="text-input" data-note-field="questionIds" multiple size="5" aria-label="关联错题">${app.data.map(q=>`<option value="${escapeHtml(q.id)}" ${(note.questionIds||[]).includes(q.id)?"selected":""}>${escapeHtml(`${q.subject} · ${(q.question||q.title||"").slice(0,90)}`)}</option>`).join("")}</select></details>${note.attachments?.length?`<div class="notes-attachments"><h3>原文件</h3>${note.attachments.map((file,index)=>`<button type="button" class="secondary-button" data-notes-action="attachment" data-attachment-index="${index}">${escapeHtml(file.name)} · 下载原文件</button>`).join("")}</div>`:""}<div class="notes-editor-actions"><span id="notes-edit-status" role="status">${escapeHtml(personalNotesStatus(note))}</span><button class="primary-button" type="submit">保存并同步</button></div></form></section>`;
}
function personalNoteImportPanel() {
  const item=personalNotes.importing;
  return `<section class="workspace-card personal-note-editor"><div class="workspace-card-head"><h2>导入文件</h2><button class="link-button" data-notes-action="list">返回列表</button></div><p>Word、PDF、图片、Excel，每个文件不超过 20MB。提取内容可编辑，原文件一起保存。</p><label class="notes-file-label">选择文件<input id="notes-source-file" class="text-input" type="file" accept=".docx,.doc,.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls"></label>${item?`<p>${escapeHtml(item.file.name)} · ${(item.file.size/1024/1024).toFixed(2)} MB</p><p id="notes-import-progress" role="status">${escapeHtml(item.progress||"")}</p>${item.error?`<p class="notes-notice error">${escapeHtml(item.error)}</p>`:""}${item.info?.kind==="pdf"?`<div class="notes-field-grid"><label>开始页<input id="notes-page-start" class="text-input" type="number" min="1" max="${item.info.pages}" value="${item.pageStart||1}"></label><label>结束页<input id="notes-page-end" class="text-input" type="number" min="1" max="${item.info.pages}" value="${item.pageEnd||item.info.pages}"></label></div>`:""}${item.info?.kind==="excel"?`<fieldset class="notes-sheets"><legend>选择工作表</legend>${item.info.sheets.map((sheet,index)=>`<label class="notes-check"><input type="checkbox" data-import-sheet="${index}" value="${escapeHtml(sheet)}" ${!item.sheets||item.sheets.includes(sheet)?"checked":""}>${escapeHtml(sheet)}</label>`).join("")}</fieldset>`:""}<div class="notes-import-actions"><button class="secondary-button" data-notes-action="extract" ${!item.info||item.busy?"disabled":""}>${item.info?.kind==="attachment"?"保留附件并编写笔记":"开始提取内容"}</button>${item.busy?`<button class="secondary-button" data-notes-action="cancel-extract">取消提取</button>`:""}${item.error?`<button class="secondary-button" data-notes-action="manual-import">保留原文件并手动编写</button>`:""}</div>${item.ready?`<form id="notes-import-form"><label>笔记标题<input id="notes-import-title" class="text-input" value="${escapeHtml(item.title)}" required maxlength="200"></label><div class="notes-field-grid"><label>科目<input id="notes-import-subject" class="text-input" value="${escapeHtml(item.subject||"")}" placeholder="可自行填写"></label><label>章节<input id="notes-import-chapter" class="text-input" value="${escapeHtml(item.chapter||"")}" placeholder="可自行填写"></label></div>${item.warnings?.length?`<ul class="notes-warnings">${item.warnings.map(w=>`<li>${escapeHtml(w)}</li>`).join("")}</ul>`:""}<label>预览并修改正文<textarea id="notes-import-body" class="text-input notes-body">${escapeHtml(item.body||"")}</textarea></label><button class="primary-button" type="submit">保存笔记和原文件</button></form>`:""}`:""}</section>`;
}
async function renderPersonalNotes() {
  const sequence=++personalNotes.sequence;
  const examId=app.examId;
  if (personalNotes.examId!==examId) {
    if(personalNotes.examId)personalNotes.sessions.set(personalNotes.examId,{draft:personalNotes.draft,mode:personalNotes.mode,importing:personalNotes.importing,revision:personalNotes.revision,unsaved:!!personalNotes.draft});
    flushPersonalNote();
    personalNotes.importing?.controller?.abort();
    const session=personalNotes.sessions.get(examId);
    personalNotes.examId=examId;personalNotes.draft=session?.draft||null;personalNotes.importing=session?.importing||null;personalNotes.mode=session?.mode||"list";personalNotes.revision++;
  }
  try {
    const store=await personalNotesStore();
    const records=await store.list(examId);
    if(sequence!==personalNotes.sequence||app.examId!==examId||app.view!=="notes")return;
    personalNotes.records=records;
    const knowledge=ReviewWorkspace.notes(workspaceQuestions());
    document.querySelector("#main").innerHTML=`<section class="workspace personal-notes"><header class="workspace-head"><h1>笔记</h1><p>自己编写、导入学习资料，或查阅已有知识点笔记。</p></header><div class="notes-toolbar"><button class="primary-button" data-notes-action="new">新建笔记</button><button class="secondary-button" data-notes-action="import">导入文件</button><button class="secondary-button" data-notes-action="sync" ${store.connection().connected?"":"disabled"}>同步笔记</button><button class="link-button" data-notes-action="export">导出备份</button><button class="link-button" data-notes-action="restore">恢复备份</button><button class="link-button" data-view="workspace">返回工作台</button></div><p id="notes-notice" class="notes-notice ${personalNotes.error?"error":""}" role="status">${escapeHtml(personalNotes.notice)}</p>${personalNoteConnection()}${personalNotes.mode==="editor"&&personalNotes.draft?personalNoteEditor():personalNotes.mode==="import"?personalNoteImportPanel():`<section class="workspace-card"><div class="workspace-card-head"><h2>我的笔记 <small>${records.length} 篇</small></h2><input id="notes-search" class="text-input notes-search" type="search" value="${escapeHtml(personalNotes.query)}" placeholder="搜索标题、正文或标签" aria-label="搜索个人笔记"></div><div id="notes-list">${personalNoteRows()}</div></section>`}<section class="workspace-card"><div class="workspace-card-head"><h2>知识点笔记</h2><span>${knowledge.length} 篇</span></div><div class="workspace-note-list">${workspaceNoteRows(knowledge)||`<p class="workbench-empty">暂无关联知识点笔记。</p>`}</div></section><input id="notes-backup-file" type="file" accept="application/json,.json" hidden></section>`;
    if(store.connection().connected&&!personalNotes.syncing.has(examId)&&Date.now()-(personalNotes.lastPulled.get(examId)||0)>60000){personalNotes.lastPulled.set(examId,Date.now());void syncPersonalNotes(examId);}
  } catch(error) {
    if(app.view==="notes"&&app.examId===examId)document.querySelector("#main").innerHTML=`<section class="workspace"><h1>笔记</h1><p class="notes-notice error">无法打开本地笔记：${escapeHtml(error.message)}</p><p>请检查浏览器是否允许此网站保存数据。</p><section class="workspace-card">${workspaceNoteRows(ReviewWorkspace.notes(workspaceQuestions()))}</section><button class="secondary-button" data-view="workspace">返回工作台</button></section>`;
  }
}
function flushPersonalNote() {
  clearTimeout(personalNotes.saveTimer);personalNotes.saveTimer=null;
  if(!personalNotes.draft)return personalNotes.savePromise;
  const snapshot=JSON.parse(JSON.stringify(personalNotes.draft));
  const revision=personalNotes.revision;
  personalNotesStatusNode("正在保存到此设备…");
  personalNotes.pendingWrites++;
  personalNotes.savePromise=personalNotes.savePromise.catch(()=>{}).then(async()=>{
    const store=await personalNotesStore();
    const redirect=personalNotes.redirects.get(snapshot.id);
    const payload=redirect?{...snapshot,id:redirect.id,_draftVersion:redirect.version,title:snapshot.title.endsWith("（冲突副本）")?snapshot.title:`${snapshot.title||"未命名笔记"}（冲突副本）`}:snapshot;
    let saved;
    try{saved=await store.save(payload);}
    catch(error){
      if(error.code!=="STALE_DRAFT")throw error;
      saved=await store.save({...payload,id:crypto.randomUUID(),_draftVersion:undefined,title:`${payload.title||"未命名笔记"}（冲突副本）`,createdAt:new Date().toISOString()});
      personalNotes.redirects.set(snapshot.id,{id:saved.id,version:saved._draftVersion});
      personalNotesMessage("另一设备更新了原笔记，当前输入已另存为冲突副本，请核对。");
    }
    personalNotes.lastSaveError=null;
    const session=personalNotes.sessions.get(snapshot.examId);
    if(session?.draft?.id===snapshot.id){
      const unchanged=["title","body","subject","chapter","tags","questionIds","attachments"].every(key=>JSON.stringify(session.draft[key])===JSON.stringify(snapshot[key]));
      session.draft.id=saved.id;session.draft._draftVersion=saved._draftVersion;
      if(unchanged){session.draft={...saved};session.unsaved=false;}
    }
    if(personalNotes.draft?.id===snapshot.id||personalNotes.draft?.id===payload.id){
      if(personalNotes.revision===revision)personalNotes.draft={...saved};
      else{if(personalNotes.draft.title===snapshot.title)personalNotes.draft.title=saved.title;personalNotes.draft.id=saved.id;personalNotes.draft._draftVersion=saved._draftVersion;personalNotes.draft.syncState="pending";}
      personalNotesStatusNode(personalNotes.revision===revision?personalNotesStatus(saved):"有新修改 · 等待保存到此设备");
    }
    if(store.connection().connected){clearTimeout(personalNotes.syncTimers.get(saved.examId));personalNotes.syncTimers.set(saved.examId,setTimeout(()=>syncPersonalNotes(saved.examId),2200));}
    return saved;
  }).catch(error=>{personalNotes.lastSaveError=error;const session=personalNotes.sessions.get(snapshot.examId);if(session?.draft?.id===snapshot.id)session.unsaved=true;personalNotesStatusNode(`保存失败：${error.message}`);personalNotesMessage(`本地保存失败，输入仍保留在当前编辑会话中：${error.message}`,true);return null;}).finally(()=>{personalNotes.pendingWrites--;});
  return personalNotes.savePromise;
}
async function requireSavedPersonalNote() {
  const hadDraft=!!personalNotes.draft;
  const saved=await flushPersonalNote();
  if(hadDraft&&!saved)throw personalNotes.lastSaveError||new Error("本地保存未完成，请先处理保存错误。");
  return saved;
}
async function syncPersonalNotes(examId=app.examId) {
  const store=await personalNotesStore();
  if(!store.connection().connected){personalNotesMessage("请先连接 GitHub；本地笔记已保留。");return;}
  if(personalNotes.syncing.has(examId)){personalNotes.syncAgain.add(examId);return personalNotes.syncing.get(examId);}
  const draftId=personalNotes.draft?.examId===examId?personalNotes.draft.id:null;
  const draftRevision=personalNotes.revision;
  personalNotes.lastPulled.set(examId,Date.now());
  const task=(async()=>{
    personalNotesMessage("正在同步笔记和原文件…");
    try {
      const result=await store.sync(examId);
      personalNotesMessage(result.conflicts?`同步完成，有 ${result.conflicts} 篇冲突笔记已保留副本，请核对。`:"笔记和原文件已同步。");
      if(draftId&&personalNotes.draft?.id===draftId){
        const latest=await store.get(draftId);
        if(latest&&personalNotes.draft?.id===draftId&&personalNotes.revision===draftRevision){
          const contentChanged=["title","body","subject","chapter","tags","questionIds","attachments","deleted"].some(key=>JSON.stringify(latest[key])!==JSON.stringify(personalNotes.draft[key]));
          personalNotes.draft={...latest};
          if(latest.deleted||(result.conflicts&&contentChanged)){personalNotes.draft=null;personalNotes.mode="list";if(app.view==="notes"&&app.examId===examId)await renderPersonalNotes();}
          else if(contentChanged&&app.view==="notes"&&app.examId===examId)await renderPersonalNotes();
          else personalNotesStatusNode(personalNotesStatus(latest));
        }else if(personalNotes.draft?.id===draftId){personalNotes.draft.syncState="pending";personalNotesStatusNode("有新修改 · 等待保存同步");}
      }
      if(app.view==="notes"&&app.examId===examId&&personalNotes.mode==="list")await renderPersonalNotes();
      return result;
    }catch(error){personalNotesMessage(`同步未完成，本地草稿已保留：${error.message}`,true);}
    finally{personalNotes.syncing.delete(examId);if(personalNotes.syncAgain.delete(examId)&&store.connection().connected)void syncPersonalNotes(examId);}
  })();
  personalNotes.syncing.set(examId,task);
  return task;
}
async function openPersonalNote(id=null) {
  const examId=app.examId,subject=workspaceSubject();
  await requireSavedPersonalNote();
  const store=await personalNotesStore();
  const draft=id?await store.get(id):{id:crypto.randomUUID(),examId,title:"未命名笔记",body:"",subject,chapter:"",tags:[],questionIds:[],attachments:[],createdAt:new Date().toISOString()};
  if(app.examId!==examId||app.view!=="notes")return;
  if(!draft||draft.deleted||draft.examId!==examId)throw new Error("这篇笔记不存在，请刷新同步。");
  personalNotes.draft=draft;personalNotes.mode="editor";personalNotes.revision++;
  await renderPersonalNotes();
}
function personalNoteDownload(blob,name) {
  const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function personalImportProgress(value) {
  const text=typeof value==="string"?value:`${value?.status||value?.message||value?.phase||"正在处理"}${typeof value?.progress==="number"?` ${Math.round(value.progress*100)}%`:""}`;
  if(personalNotes.importing)personalNotes.importing.progress=text;
  const node=document.querySelector("#notes-import-progress");if(node)node.textContent=text;
}
async function inspectPersonalNoteFile(file) {
  if(!file)return;
  if(file.size>20*1024*1024)throw new Error("每个文件不超过20MB，请拆分后导入。");
  personalNotes.importing?.controller?.abort();
  const item=personalNotes.importing={examId:app.examId,id:crypto.randomUUID(),file,title:file.name.replace(/\.[^.]+$/,""),subject:workspaceSubject(),chapter:"",progress:"正在读取文件信息…",busy:true};
  try{item.info=await ReviewNoteImport.inspect(file);item.progress="请选择范围或工作表，然后提取内容。";item.warnings=item.info.warnings||[];}
  catch(error){item.error=error.message;item.progress="未能解析文件；可保留原文件并手动编写。";}
  finally{item.busy=false;if(personalNotes.importing===item&&app.view==="notes")await renderPersonalNotes();}
}
async function extractPersonalNoteFile() {
  const item=personalNotes.importing;if(!item?.info||item.busy)return;
  item.controller=new AbortController();item.busy=true;item.error="";
  const options={signal:item.controller.signal,onProgress:personalImportProgress};
  if(item.info.kind==="pdf"){options.pageStart=Number(document.querySelector("#notes-page-start").value);options.pageEnd=Number(document.querySelector("#notes-page-end").value);item.pageStart=options.pageStart;item.pageEnd=options.pageEnd;}
  if(item.info.kind==="excel"){options.sheets=Array.from(document.querySelectorAll("[data-import-sheet]:checked"),node=>node.value);item.sheets=options.sheets;}
  await renderPersonalNotes();
  try{const result=await ReviewNoteImport.extract(item.file,options);item.body=result.body||"";item.warnings=[...(item.info.warnings||[]),...(result.warnings||[])];item.ready=true;item.progress="提取完成，请核对并修改内容后保存。";}
  catch(error){item.error=error.name==="AbortError"?"已取消提取，原文件仍可保存。":error.message;}
  finally{item.busy=false;if(personalNotes.importing===item&&app.view==="notes")await renderPersonalNotes();}
}
if(typeof document!=="undefined") {
  document.addEventListener("input",event=>{
    const target=event.target;
    if(target.id==="notes-search"){personalNotes.query=target.value;document.querySelector("#notes-list").innerHTML=personalNoteRows();return;}
    const field=target.dataset?.noteField;
    if(field&&personalNotes.draft){personalNotes.draft.syncState="pending";personalNotesStatusNode("有新修改 · 等待保存到此设备");personalNotes.draft[field]=field==="tags"?personalNotesTags(target.value):field==="questionIds"?Array.from(target.selectedOptions,option=>option.value):target.value;personalNotes.revision++;clearTimeout(personalNotes.saveTimer);personalNotes.saveTimer=setTimeout(flushPersonalNote,350);if(field==="body")document.querySelector("#notes-preview-content").innerHTML=personalNotesMarkdown(target.value);}
    const item=personalNotes.importing;
    if(item){const fields={"notes-import-title":"title","notes-import-body":"body","notes-import-subject":"subject","notes-import-chapter":"chapter"};if(fields[target.id])item[fields[target.id]]=target.value;}
  });
  document.addEventListener("click",async event=>{
    const button=event.target.closest("button");if(!button||button.disabled)return;
    const action=button.dataset.notesAction;
    if(!action){if(app.view==="notes"&&(button.dataset.view||button.dataset.workspaceExam||button.dataset.action)){flushPersonalNote();personalNotes.importing?.controller?.abort();}return;}
    event.preventDefault();
    try{
      const store=await personalNotesStore();
      if(app.view!=="notes"&&["new","import","open"].includes(action)){app.view="notes";render();}
      if(action==="new")await openPersonalNote();
      if(action==="open")await openPersonalNote(button.dataset.noteId);
      if(action==="list"){await requireSavedPersonalNote();personalNotes.importing?.controller?.abort();personalNotes.mode="list";personalNotes.draft=null;await renderPersonalNotes();}
      if(action==="import"){await requireSavedPersonalNote();personalNotes.draft=null;personalNotes.mode="import";personalNotes.importing=null;await renderPersonalNotes();}
      if(action==="sync"){await requireSavedPersonalNote();await syncPersonalNotes();}
      if(action==="disconnect"){await store.disconnect();personalNotesMessage("已断开 GitHub，本地笔记和原文件仍保留。");await renderPersonalNotes();}
      if(action==="delete"&&confirm("确定删除这篇笔记？连接后会同步删除状态。")){await store.remove(button.dataset.noteId);if(personalNotes.draft?.id===button.dataset.noteId)personalNotes.draft=null;await syncPersonalNotes();await renderPersonalNotes();}
      if(action==="attachment"){const file=personalNotes.draft?.attachments[Number(button.dataset.attachmentIndex)];if(file)personalNoteDownload(await store.getAttachment(file),file.name);}
      if(action==="export"){await requireSavedPersonalNote();personalNotesMessage("正在准备包含全部原文件的备份…");personalNoteDownload(await store.exportBackup(app.examId),`个人笔记-${app.examId}-${ReviewScheduler.beijingDate()}.json`);personalNotesMessage("备份已生成，包含笔记正文和原文件。");}
      if(action==="restore")document.querySelector("#notes-backup-file").click();
      if(action==="extract")await extractPersonalNoteFile();
      if(action==="cancel-extract")personalNotes.importing?.controller?.abort();
      if(action==="manual-import"){const item=personalNotes.importing;item.ready=true;item.body=item.body||"";item.warnings=["保存时会保留原文件；正文尚未提取，请自行填写。",...(item.warnings||[])];await renderPersonalNotes();}
    }catch(error){personalNotesMessage(error.message,true);}
  });
  document.addEventListener("submit",async event=>{
    if(!["notes-connect-form","notes-editor-form","notes-import-form"].includes(event.target.id))return;
    event.preventDefault();
    try{
      const store=await personalNotesStore();
      if(event.target.id==="notes-connect-form"){const input=document.querySelector("#notes-token");const token=input.value;const remember=document.querySelector("#notes-remember").checked;input.value="";await store.connect(token,{remember});await syncPersonalNotes();await renderPersonalNotes();}
      if(event.target.id==="notes-editor-form"){await requireSavedPersonalNote();await syncPersonalNotes();}
      if(event.target.id==="notes-import-form"){
        const item=personalNotes.importing;if(!item?.ready)throw new Error("请先核对导入内容。");
        if(item.saving)return;
        item.saving=true;
        const payload={id:item.id||(item.id=crypto.randomUUID()),examId:item.examId||app.examId,title:document.querySelector("#notes-import-title").value,body:document.querySelector("#notes-import-body").value,subject:document.querySelector("#notes-import-subject").value,chapter:document.querySelector("#notes-import-chapter").value,tags:[],questionIds:[]};
        document.querySelectorAll("#notes-import-form input, #notes-import-form textarea, #notes-import-form button").forEach(node=>{node.disabled=true;});
        try{
          personalNotesMessage("正在保存笔记和原文件…");
          const attachment=await store.addAttachment(item.file);
          const saved=await store.save({...payload,attachments:[attachment]});
          if(personalNotes.importing===item&&app.examId===payload.examId&&app.view==="notes"){
            personalNotes.importing=null;personalNotes.draft=saved;personalNotes.mode="editor";personalNotes.revision++;
            await renderPersonalNotes();
          }
          await syncPersonalNotes(saved.examId);
        }finally{item.saving=false;document.querySelectorAll("#notes-import-form input, #notes-import-form textarea, #notes-import-form button").forEach(node=>{node.disabled=false;});}
      }
    }catch(error){personalNotesMessage(error.message,true);}
  });
  document.addEventListener("change",async event=>{
    try{
      if(event.target.id==="notes-source-file")await inspectPersonalNoteFile(event.target.files[0]);
      if(event.target.id==="notes-backup-file"&&event.target.files[0]){const result=await(await personalNotesStore()).importBackup(event.target.files[0]);personalNotesMessage(`已恢复 ${result.imported} 篇笔记${result.copies?`，保留 ${result.copies} 份冲突副本`:""}。`);await renderPersonalNotes();}
    }catch(error){personalNotesMessage(error.message,true);}
  });
  if(typeof window!=="undefined"){
    window.addEventListener("online",async()=>{if(personalNotes.store?.connection().connected)for(const exam of app.exams)await syncPersonalNotes(exam.id);});
    window.addEventListener("beforeunload",event=>{if(personalNotes.saveTimer||personalNotes.pendingWrites||personalNotes.lastSaveError||[...personalNotes.sessions.values()].some(session=>session.unsaved)||personalNotes.importing?.ready){event.preventDefault();event.returnValue="";}});
    window.addEventListener("pagehide",()=>{flushPersonalNote();});
  }
}
