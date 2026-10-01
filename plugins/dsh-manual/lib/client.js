window.__ModuleLoader__.load({
  id: 'dsh-manual',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const dictionaries = {
      zh: {
        title: 'DSH 手册', subtitle: '查功能、学调用、记录经验。项目资料自动同步，笔记独立保留。',
        search: '搜索手册', refresh: '刷新列表', sync: '同步项目资料', new: '新建笔记',
        save: '保存草稿', copy: '复制为笔记', history: '修订历史', restore: '恢复所选修订',
        discard: '放弃未保存修改', dirty: '有未保存修改：请保存或放弃后再切换。',
        saved: '草稿已保存', conflict: '版本冲突：你的草稿已保留。请复制草稿，放弃修改后重新读取，再合并保存。',
        loading: '正在读取…', empty: '没有匹配的条目', generated: '项目资料 · 只读来源', draft: '笔记 · 待验证草稿',
        noteTitle: '笔记标题', body: 'Markdown 正文', reason: '修改原因 / 验证依据',
        id: '文档 ID', source: '来源', revision: '修订', freshness: '资料状态',
        next: '下一页', previous: '上一页', complete: '已同步', pending: '尚未同步', partial: '部分来源未同步，请检查来源或冲突',
        failed: '操作失败', truncated: '正文已截断，不能保存。请在 Markdown 文件中编辑完整内容。',
        intro: '从左侧选择文档，或创建笔记。手册是参考资料，不会自动赋予模型新的操作权限。',
        stale: '来源已失效或变化，请核对后使用。', required: '请填写标题和正文。',
        newTitle: '新笔记', newReason: '补充使用经验', copied: '资料已复制为新草稿；保存后才会写入。',
        noHistory: '暂无修订', restoreHint: '恢复会创建新修订，保留现有历史。', status: '同步状态',
      },
      en: {
        title: 'DSH handbook', subtitle: 'Discover features, learn invocation and retain experience. Sources and notes stay separate.',
        search: 'Search handbook', refresh: 'Refresh list', sync: 'Sync project sources', new: 'New note',
        save: 'Save draft', copy: 'Copy to note', history: 'Revision history', restore: 'Restore selected revision',
        discard: 'Discard unsaved changes', dirty: 'Unsaved changes: save or discard before switching.',
        saved: 'Draft saved', conflict: 'Revision conflict. Your draft is preserved. Copy it, discard, reload and merge before saving.',
        loading: 'Loading…', empty: 'No matching documents', generated: 'Project source · read-only', draft: 'Note · unverified draft',
        noteTitle: 'Note title', body: 'Markdown body', reason: 'Change reason / validation evidence',
        id: 'Document ID', source: 'Source', revision: 'Revision', freshness: 'Freshness',
        next: 'Next', previous: 'Previous', complete: 'Synced', pending: 'Not synced yet', partial: 'Some sources were not synced; check source availability or conflicts',
        failed: 'Operation failed', truncated: 'Content is truncated and cannot be saved. Edit the complete Markdown file instead.',
        intro: 'Select a document or create a note. Handbook text is reference material and does not grant permissions.',
        stale: 'Source is missing or changed. Verify before use.', required: 'Title and content are required.',
        newTitle: 'New note', newReason: 'Document usage experience', copied: 'Copied to a new draft; save to persist.',
        noHistory: 'No revisions', restoreHint: 'Restoring creates a revision and preserves history.', status: 'Sync status',
      },
    };
    async function api(body, signal) {
      const res = await fetch('/dsh-manual/api', {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'content-type': 'application/json', 'x-dsh-manual': '1' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw Object.assign(new Error(data.error?.code || 'UNAVAILABLE'), { code: data.error?.code });
      return data.value;
    }
    function Manual({ t }) {
      const [query, setQuery] = useState('');
      const [page, setPage] = useState({ items: [], offset: 0, nextOffset: null });
      const [doc, setDoc] = useState(null);
      const [content, setContent] = useState('');
      const [title, setTitle] = useState('');
      const [reason, setReason] = useState('');
      const [revisions, setRevisions] = useState([]);
      const [selectedRevision, selectRevision] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const [syncState, setSyncState] = useState(null);
      const mounted = useRef(true);
      const aborts = useRef(new Set());
      const dirty = doc && (content !== doc.content || title !== doc.title);
      const editable = doc?.kind === 'note' && !doc?.truncated;
      const call = async body => {
        const abort = new AbortController(); aborts.current.add(abort);
        try { return await api(body, abort.signal); } finally { aborts.current.delete(abort); }
      };
      const act = async fn => {
        if (busy) return;
        setBusy(true); setNotice('');
        try { await fn(); }
        catch (error) { if (mounted.current && error.name !== 'AbortError') setNotice(error.code === 'REVISION_CONFLICT' ? t('conflict') : `${t('failed')}: ${error.code || 'UNAVAILABLE'}`); }
        finally { if (mounted.current) setBusy(false); }
      };
      const loadList = async (offset = 0) => {
        const data = await call({ operation: query.trim() ? 'search' : 'list', query, offset, limit: 30 });
        if (mounted.current) setPage(data);
      };
      const accept = data => {
        setDoc(data); setContent(data.content || ''); setTitle(data.title || ''); setReason('');
        setRevisions([]); selectRevision('');
      };
      const open = id => {
        if (dirty) return setNotice(t('dirty'));
        return act(async () => accept(await call({ operation: 'read', id, limit: 262144 })));
      };
      const makeNote = copy => {
        if (dirty) return setNotice(t('dirty'));
        const id = 'notes/n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
        const data = { id, kind: 'note', revision: null, title: '', content: '', status: 'draft' };
        accept(data); setTitle(copy ? doc.title : t('newTitle'));
        setContent(copy ? doc.content : ''); setReason(t('newReason'));
        if (copy) setNotice(t('copied'));
      };
      useEffect(() => {
        mounted.current = true;
        void act(async () => { await loadList(); const value = await call({ operation: 'status' }); if (mounted.current) setSyncState(value.lastSync); });
        return () => { mounted.current = false; for (const controller of aborts.current) controller.abort(); };
      }, []);
      const button = (key, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: busy || disabled }, t(key));
      return h('section', { className: 'dshm', 'aria-label': t('title') },
        h('p', { className: 'dshm-subtitle' }, t('subtitle')),
        h('div', { className: 'dshm-actions' },
          button('new', () => makeNote(false)),
          button('sync', () => act(async () => { await call({ operation: 'sync' }); await loadList(); const status = await call({ operation: 'status' }); setSyncState(status.lastSync); setNotice(t(status.lastSync.status === 'ready' ? 'complete' : 'partial')); })),
          h('small', { title: syncState?.issues?.map(issue => `${issue.source}: ${issue.code || issue.reason}`).join('\n') }, `${t('status')}: ${syncState?.status === 'ready' ? t('complete') : syncState?.status === 'partial' ? t('partial') : syncState?.status || t('pending')}${syncState?.at ? ' · ' + new Date(syncState.at).toLocaleTimeString() : ''}`)),
        h('div', { role: 'status', 'aria-live': 'polite', className: 'dshm-notice' }, busy ? t('loading') : notice),
        h('div', { className: 'dshm-grid' },
          h('aside', { className: 'dshm-list' },
            h('form', { onSubmit: event => { event.preventDefault(); void act(() => loadList()); } },
              h('input', { 'aria-label': t('search'), placeholder: t('search'), value: query, maxLength: 300, onChange: event => setQuery(event.target.value) }),
              h('button', { type: 'submit', disabled: busy }, t('search'))),
            page.items.length ? h('ul', null, page.items.map(item => h('li', { key: item.id }, h('button', { type: 'button', disabled: busy, 'aria-current': doc?.id === item.id ? 'page' : undefined, onClick: () => open(item.id) }, item.title || item.id)))) : h('p', null, t('empty')),
            h('div', { className: 'dshm-actions' }, button('previous', () => act(() => loadList(Math.max(0, page.offset - 30))), !page.offset), button('next', () => act(() => loadList(page.nextOffset)), page.nextOffset == null))),
          h('article', { className: 'dshm-editor' }, doc ? [
            h('div', { key: 'meta', className: 'dshm-meta' },
              h('strong', null, t(doc.kind === 'note' ? 'draft' : 'generated')),
              h('small', null, `${t('id')}: ${doc.id}`),
              h('small', null, `${t('revision')}: ${doc.revision?.slice(0, 16) || '—'}`),
              doc.source ? h('small', null, `${t('source')}: ${typeof doc.source === 'string' ? doc.source : doc.source.path || JSON.stringify(doc.source)}`) : null,
              doc.freshness ? h('small', null, `${t('freshness')}: ${typeof doc.freshness === 'string' ? doc.freshness : JSON.stringify(doc.freshness)}`) : null),
            h('label', { key: 'title' }, t('noteTitle'), h('input', { value: title, readOnly: !editable, maxLength: 160, onChange: event => setTitle(event.target.value) })),
            h('label', { key: 'body' }, t('body'), h('textarea', { value: content, readOnly: !editable, spellCheck: false, rows: 20, onChange: event => setContent(event.target.value) })),
            doc.truncated ? h('p', { key: 'truncated', role: 'alert' }, t('truncated')) : null,
            editable ? h('label', { key: 'reason' }, t('reason'), h('input', { value: reason, maxLength: 500, onChange: event => setReason(event.target.value) })) : null,
            h('div', { key: 'actions', className: 'dshm-actions' },
              editable ? button('save', () => act(async () => {
                if (!title.trim() || !content.trim()) return setNotice(t('required'));
                const saved = await call({ operation: 'edit', id: doc.id, title, content, reason, expectedRevision: doc.revision });
                accept(saved); await loadList(page.offset); setNotice(t('saved'));
              }), !dirty) : button('copy', () => makeNote(true), doc.truncated),
              button('discard', () => { accept(doc); setNotice(''); }, !dirty),
              button('history', () => act(async () => { const value = await call({ operation: 'history', id: doc.id }); setRevisions(value.items); if (!value.items.length) setNotice(t('noHistory')); }), !doc.revision)),
            revisions.length ? h('div', { key: 'history', className: 'dshm-history' },
              h('label', null, t('history'), h('select', { value: selectedRevision, onChange: event => selectRevision(event.target.value) },
                h('option', { value: '' }, '—'), revisions.map(item => h('option', { key: item.revision, value: item.revision }, `${item.revision.slice(0, 12)} · ${item.reason || item.title || ''}`)))),
              h('small', null, t('restoreHint')),
              button('restore', () => act(async () => { const restored = await call({ operation: 'restore', id: doc.id, revision: selectedRevision, expectedRevision: doc.revision, reason: t('restoreHint') }); accept(restored); setNotice(t('saved')); }), !editable || !selectedRevision || dirty)) : null,
          ] : h('p', null, t('intro')))));
    }
    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('dsh-manual', dictionaries), 'dsh-manual: translations');
        const t = ctx.locale.bind('dsh-manual');
        ctx.effect(() => {
          const style = document.createElement('style'); style.dataset.plugin = 'dsh-manual';
          style.textContent = '.dshm{max-width:1100px;min-width:0;color:inherit;font:inherit}.dshm *{box-sizing:border-box}.dshm-subtitle,.dshm small{opacity:.75}.dshm-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0}.dshm button,.dshm input,.dshm textarea,.dshm select{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;padding:7px 9px}.dshm button{cursor:pointer}.dshm button:disabled{opacity:.45;cursor:default}.dshm button[aria-current]{background:color-mix(in srgb,currentColor 10%,transparent)}.dshm input,.dshm textarea{width:100%;min-width:0}.dshm textarea{font:13px/1.6 ui-monospace,Consolas,monospace;resize:vertical}.dshm-grid{display:grid;grid-template-columns:minmax(150px,230px) minmax(0,1fr);gap:20px}.dshm-list ul{padding:0;list-style:none;max-height:580px;overflow:auto}.dshm-list li button{width:100%;text-align:left;overflow-wrap:anywhere;margin-bottom:5px}.dshm-list form{display:flex;flex-wrap:wrap;gap:6px}.dshm-editor{min-width:0}.dshm-editor label{display:block;margin:8px 0}.dshm-meta{display:flex;flex-direction:column;gap:5px;overflow-wrap:anywhere}.dshm-notice{min-height:26px;overflow-wrap:anywhere}.dshm-history{display:flex;flex-direction:column;align-items:start;gap:8px}@media(max-width:720px){.dshm-grid{grid-template-columns:1fr}.dshm-list ul{max-height:170px}}';
          document.head.appendChild(style); return () => style.remove();
        }, 'dsh-manual: scoped styles');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-manual', order: 21, label: () => t('title'), locale: 'dsh-manual', inject: () => ({ t }),
        }, Manual));
      },
    };
  },
});
