/**
 * Client half of the "Delete Conversation" bundle.
 *
 * Adds one "Delete conversation" row to each Session's "..." menu
 * (`sidebar.workspaces.session.menu.item`) and a confirmation dialog in
 * `shell.overlay`. The dialog first asks the Host for a read-only deletion
 * plan (local logs, projection cache, spill files and produced files), lets
 * the user choose which produced files to delete, and only then sends the
 * destructive request with the exact confirmed path list.
 *
 * @author weapon111 (https://github.com/weapon111)
 * @copyright Copyright (c) 2026 weapon111. All rights reserved.
 * @license MIT — attribution to weapon111 is mandatory.
 *          https://github.com/weapon111/dsh-delete-conversation
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-delete-conversation',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useEffect = React.useEffect
    const useState = React.useState
    const useSyncExternalStore = React.useSyncExternalStore
    const useCallback = React.useCallback

    const NS = 'dsh-delete-conversation'

    const DICTS = {
      en: {
        'menu.delete': 'Delete conversation',
        'dialog.title': 'Delete this conversation?',
        'dialog.intro': 'This permanently deletes the conversation and its local cache files. It cannot be undone.',
        'dialog.logs': 'Local cache files',
        'dialog.files': 'Produced files (choose which to delete)',
        'dialog.noFiles': 'No produced files were recorded in this conversation.',
        'dialog.alsoFiles': 'Also delete the produced files listed above',
        'dialog.confirm': 'Delete conversation',
        'dialog.cancel': 'Cancel',
        'dialog.deleting': 'Deleting…',
        'dialog.irreversible': 'Deleting produced files removes them from your workspace permanently.',
        'dialog.outside': 'shared / outside this workspace — kept',
        'dialog.outsideTitle': 'Delivered files outside this workspace (not deleted)',
        'dialog.outsideWarn': 'These are usually shared assets (skills, tools, libraries). They are never deleted automatically.',
        'toast.ok': 'Conversation deleted',
        'toast.failed': 'Delete failed: {message}',
        'error.title': 'Could not delete conversation',
      },
      zh: {
        'menu.delete': '删除对话',
        'dialog.title': '删除这个对话？',
        'dialog.intro': '此操作会永久删除该对话及其本地缓存文件，且无法撤销。',
        'dialog.logs': '本地缓存文件',
        'dialog.files': '产出的文件（勾选要删除的）',
        'dialog.noFiles': '该对话没有记录任何产出文件。',
        'dialog.alsoFiles': '同时删除上面列出的产出文件',
        'dialog.confirm': '删除对话',
        'dialog.cancel': '取消',
        'dialog.deleting': '正在删除…',
        'dialog.irreversible': '删除产出文件会把它们从工作区中永久移除。',
        'dialog.outside': '共享文件 / 工作区之外 — 保留',
        'dialog.outsideTitle': '工作区之外引用的文件（不会删除）',
        'dialog.outsideWarn': '这些通常是共享资源（技能、工具、库），不会被自动删除。',
        'toast.ok': '对话已删除',
        'toast.failed': '删除失败：{message}',
        'error.title': '无法删除对话',
      },
    }

    /** Shared request state owned by the plugin context. */
    function createState() {
      return {
        request: null, // { sessionId, displayTitle }
        listeners: new Set(),
        subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) },
        getSnapshot() { return this.request },
        emit() { for (const fn of [...this.listeners]) fn() },
        ask(sessionId, displayTitle) { this.request = { sessionId, displayTitle }; this.emit() },
        close() { this.request = null; this.emit() },
      }
    }

    function translate(ctx, key, params) {
      const locale = ctx?.get?.('locale')
      let text
      if (locale !== undefined) {
        try { text = locale.bind(NS)(key, params) } catch { /* fall through */ }
      }
      if (typeof text !== 'string' || text.length === 0 || text === key) {
        let current = 'en'
        try { current = locale?.getSnapshot?.().id ?? 'en' } catch { /* default */ }
        text = (DICTS[current] ?? DICTS.en)[key] ?? DICTS.en[key] ?? key
      }
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.split(`{${name}}`).join(String(value))
        }
      }
      return text
    }

    function formatSize(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function apiUrl(pathname) {
      try { return new URL(pathname, document.baseURI).href } catch { return pathname }
    }

    async function rpc(op, payload) {
      const response = await fetch(apiUrl('api/dsh-delete-conversation/rpc'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...(payload ?? {}) }),
      })
      let body = null
      try { body = await response.json() } catch { body = null }
      if (body === null) throw new Error(`Delete request failed (${response.status})`)
      if (body.ok !== true) throw new Error(body.error ?? `Delete request failed (${response.status})`)
      return body.value
    }

    /* ---------------------------------------------------------------- *
     * Styles: host theme tokens only; prefixed to avoid collisions.
     * ---------------------------------------------------------------- */

    const CSS = [
      '.ddc-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;',
      'background:rgba(0,0,0,.45);padding:24px;font-family:inherit}',
      '.ddc-dialog{width:min(560px,100%);max-height:min(80vh,720px);overflow:auto;box-sizing:border-box;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:22px 24px;',
      'box-shadow:0 18px 60px rgba(0,0,0,.28);font-size:13px;line-height:1.55}',
      '.ddc-title{margin:0 0 8px;font-size:17px;font-weight:650}',
      '.ddc-intro{margin:0 0 16px;color:var(--dsw-alias-label-secondary)}',
      '.ddc-section{margin:0 0 6px;font-weight:600;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ddc-list{margin:0 0 14px;padding:10px 12px;list-style:none;background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:9px;max-height:170px;overflow:auto}',
      '.ddc-row{display:flex;align-items:flex-start;gap:9px;padding:3px 0;min-width:0}',
      '.ddc-path{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}',
      '.ddc-meta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}',
      '.ddc-empty{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0 0 14px}',
      '.ddc-toggle{display:flex;align-items:center;gap:9px;margin:0 0 10px;cursor:pointer;',
      'color:var(--dsw-alias-label-primary);font-size:12.5px}',
      '.ddc-toggle input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary)}',
      '.ddc-check{width:15px;height:15px;flex:0 0 15px;accent-color:var(--dsw-alias-state-error-primary)}',
      '.ddc-warn{color:var(--dsw-alias-state-warn-primary);font-size:11.5px;margin:0 0 14px}',
      '.ddc-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:0 0 12px;word-break:break-word}',
      '.ddc-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}',
      '.ddc-btn{appearance:none;border-radius:8px;padding:8px 16px;font-size:13px;font-family:inherit;',
      'cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary)}',
      '.ddc-btn:disabled{opacity:.55;cursor:default}',
      '.ddc-btn-danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff;font-weight:600}',
      '.ddc-menu-item{display:flex;align-items:center;gap:8px;width:100%;text-align:left;',
      'appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:8px 10px;',
      'border-radius:7px;cursor:pointer}',
      '.ddc-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ddc-trash{flex:0 0 14px;height:14px;opacity:.85}',
      '.ddc-loading{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0 0 14px}',
    ].join('\n')

    function TrashIcon() {
      return h('svg', { className: 'ddc-trash', viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'currentColor' },
        h('path', { d: 'M6.5 1h3a1 1 0 0 1 1 1v1H13a.5.5 0 0 1 0 1h-.55l-.7 9.1A2 2 0 0 1 9.76 15H6.24a2 2 0 0 1-1.99-1.9L3.55 4H3a.5.5 0 0 1 0-1h3.5V2a1 1 0 0 1 1-1zm-1 3-.68 8.85A1 1 0 0 0 5.82 13.9h4.36a1 1 0 0 0 1-1.05L10.5 4h-5zM6 6.5a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0v-5zm3 0a.5.5 0 0 1 1 0v5a.5.5 0 0 1-1 0v-5zM8 2v1h1V2a0 0 0 0 0 0 0H8z' }))
    }

    /* ---------------------------------------------------------------- *
     * Menu row
     * ---------------------------------------------------------------- */

    function DeleteMenuItem(props) {
      const { sessionId, displayTitle, useMenuOpenState, requestDelete, t } = props
      const [, setMenuOpen] = useMenuOpenState()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'ddc-menu-item',
        onClick: () => {
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle || sessionId)
        },
      }, h(TrashIcon), t('menu.delete'))
    }

    /* ---------------------------------------------------------------- *
     * Confirmation dialog (shell.overlay)
     * ---------------------------------------------------------------- */

    function DeleteDialog(props) {
      const { state, ctx, t } = props
      const subscribe = useCallback((fn) => state.subscribe(fn), [state])
      const getSnapshot = useCallback(() => state.getSnapshot(), [state])
      const request = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

      const [plan, setPlan] = useState(null)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [deleteFiles, setDeleteFiles] = useState(false)
      const [checked, setChecked] = useState({})

      const sessionId = request?.sessionId

      useEffect(() => {
        let alive = true
        if (!sessionId) {
          setPlan(null); setError(''); setChecked({}); setDeleteFiles(false)
          return undefined
        }
        setPlan(null); setError(''); setBusy(false); setChecked({}); setDeleteFiles(false)
        rpc('inspect', { sessionId })
          .then((value) => { if (alive) setPlan(value) })
          .catch((reason) => { if (alive) setError(String(reason?.message ?? reason)) })
        return () => { alive = false }
      }, [sessionId])

      useEffect(() => {
        if (!sessionId) return undefined
        const onKey = (event) => { if (event.key === 'Escape' && !busy) state.close() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [sessionId, busy])

      if (!request) return null

      const produced = plan?.producedFiles ?? []
      const existing = produced.filter((file) => file.exists && !file.isDirectory && !file.outsideWorkspace)
      const outside = produced.filter((file) => file.outsideWorkspace && file.exists && !file.isDirectory)
      const logs = plan?.logs ?? []
      const projcache = plan?.projectionCache ?? []
      const spill = plan?.spill ?? []

      const confirm = async () => {
        setBusy(true)
        setError('')
        const confirmedPaths = deleteFiles
          ? existing.filter((file) => checked[file.path] !== false).map((file) => file.path)
          : []
        try {
          const result = await rpc('delete', { sessionId, confirmedPaths })
          if (result.errors && result.errors.length > 0) {
            setError(result.errors.map((item) => `${item.stage}: ${item.message}`).join('; '))
            setBusy(false)
            return
          }
          state.close()
          try { ctx?.get?.('uiWorkspace')?.openSession?.(undefined) } catch { /* navigation is best effort */ }
          window.dispatchEvent(new CustomEvent('dsh-delete-conversation:done', { detail: { sessionId } }))
        } catch (reason) {
          setError(String(reason?.message ?? reason))
          setBusy(false)
        }
      }

      const toggleAll = (value) => {
        setDeleteFiles(value)
        const next = {}
        for (const file of existing) next[file.path] = value
        setChecked(next)
      }

      const logRows = [
        ...logs.map((file, index) => h('li', { className: 'ddc-row', key: `log-${index}` },
          h('span', { className: 'ddc-path' }, file.label || file.path),
          h('span', { className: 'ddc-meta' }, formatSize(file.size)))),
        ...projcache.map((file, index) => h('li', { className: 'ddc-row', key: `pc-${index}` },
          h('span', { className: 'ddc-path' }, file.path),
          h('span', { className: 'ddc-meta' }, formatSize(file.size)))),
        ...spill.map((file, index) => h('li', { className: 'ddc-row', key: `sp-${index}` },
          h('span', { className: 'ddc-path' }, file.path))),
      ]

      let filesBlock
      if (existing.length === 0 && outside.length === 0) {
        filesBlock = h('p', { className: 'ddc-empty' }, t('dialog.noFiles'))
      } else {
        const fileRows = existing.map((file, index) => h('label', { className: 'ddc-row', key: `df-${index}` },
          h('input', {
            type: 'checkbox', className: 'ddc-check', disabled: busy || !deleteFiles,
            checked: deleteFiles && checked[file.path] !== false,
            onChange: (event) => setChecked((current) => ({ ...current, [file.path]: event.target.checked })),
          }),
          h('span', { className: 'ddc-path', style: { flex: 1 } }, file.path),
          h('span', { className: 'ddc-meta' }, formatSize(file.size))))
        const outsideRows = outside.map((file, index) => h('li', { className: 'ddc-row', key: `out-${index}` },
          h('span', { className: 'ddc-path' }, file.path),
          h('span', { className: 'ddc-meta' }, t('dialog.outside'))))
        filesBlock = h(React.Fragment, null,
          h('p', { className: 'ddc-section' }, `${t('dialog.files')} (${existing.length})`),
          existing.length > 0
            ? h(React.Fragment, null,
                h('label', { className: 'ddc-toggle' },
                  h('input', { type: 'checkbox', checked: deleteFiles, disabled: busy, onChange: (event) => toggleAll(event.target.checked) }),
                  t('dialog.alsoFiles')),
                h('div', { className: 'ddc-list' }, ...fileRows))
            : h('p', { className: 'ddc-empty' }, t('dialog.noFiles')),
          outside.length > 0
            ? h(React.Fragment, null,
                h('p', { className: 'ddc-section' }, `${t('dialog.outsideTitle')} (${outside.length})`),
                h('ul', { className: 'ddc-list' }, ...outsideRows),
                h('p', { className: 'ddc-warn' }, t('dialog.outsideWarn')))
            : null,
          existing.length > 0 ? h('p', { className: 'ddc-warn' }, t('dialog.irreversible')) : null)
      }

      const planBlock = plan === null
        ? (error ? null : h('p', { className: 'ddc-loading' }, t('dialog.deleting')))
        : h(React.Fragment, null,
            h('p', { className: 'ddc-section' }, `${t('dialog.logs')} (${logRows.length})`),
            h('ul', { className: 'ddc-list' }, ...logRows),
            filesBlock)

      const actions = h('div', { className: 'ddc-actions' },
        h('button', { type: 'button', className: 'ddc-btn', disabled: busy, onClick: () => state.close() }, t('dialog.cancel')),
        h('button', {
          type: 'button', className: 'ddc-btn ddc-btn-danger', disabled: busy || !plan,
          onClick: confirm,
        }, busy ? t('dialog.deleting') : t('dialog.confirm')))

      const dialog = h('div', { className: 'ddc-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('dialog.title') },
        h('h2', { className: 'ddc-title' }, t('dialog.title')),
        h('p', { className: 'ddc-intro' }, t('dialog.intro')),
        error ? h('p', { className: 'ddc-error' }, error) : null,
        planBlock,
        actions)

      return h('div', {
        className: 'ddc-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) state.close() },
      }, dialog)
    }

    /* ---------------------------------------------------------------- *
     * Plugin apply
     * ---------------------------------------------------------------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const state = createState()

        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-delete-conversation: styles')

        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en), 'dsh-delete-conversation: en dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh), 'dsh-delete-conversation: zh dictionary')

        const t = (key, params) => translate(ctx, key, params)

        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'dsh-delete-conversation.delete',
            order: 500,
            label: () => t('menu.delete'),
            locale: NS,
            inject: () => ({
              requestDelete: (sessionId, displayTitle) => state.ask(sessionId, displayTitle),
              t,
            }),
          }, DeleteMenuItem)
        })

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: 'dsh-delete-conversation.dialog',
            order: 500,
          }, () => h(DeleteDialog, { state, ctx, t }))
        })
      },
    }
  },
})
