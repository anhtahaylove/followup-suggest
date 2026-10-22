import { expect, test } from 'claude-code/testing'
import { pickSkills, knownCommandNames, dropUnknownCommands, cleanText, computeTuning, extractPaths, dropCoveredByAnswer, answerListLines, forbiddenVerbs, dropForbidden, dropOffTopic, STRINGS, detectLang, parseLine, cleanLine, existsTarget, isRisky, dropAlreadyChecked } from '../hooks/register.js'

type Seen = {
  forkCalls: number; haikuCalls: number; draft: string; fills: string[]; attended?: string; forkThrows?: boolean
  store: Record<string, unknown>; missing?: string[]; forkPrompt?: string; forkGate?: Promise<void>; commands?: Array<{ name: string; description: string; source: string }>
}

// Stubs answer in Claude Code's place, in the shape the test kit asks for per event.
// forkText: text the session-model fork returns, or null = the fork cannot answer.
// haikuText: text the Haiku fallback returns, or null = it cannot answer either.
function stubs(on: any, forkText: string | null, haikuText: string | null, seen: Seen) {
  on('session.start', (_api: unknown, e: unknown) => e)
  on('turn.complete', () => ({ text: '' }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', (_api: unknown, e: unknown) => e)
  on('turn.start', (_api: unknown, e: unknown) => e)
  on('command.register', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('session.surfaces', () => {
    if (seen.attended === 'throw') throw new Error('unknown method session.surfaces')
    return { value: seen.attended === '0' ? [] : ['terminal'] }
  })
  on('store.get', (_api: unknown, e: { key: string }) => ({ value: seen.store[e.key] }))
  on('store.set', (_api: unknown, e: { key: string; value: unknown }) => { seen.store[e.key] = e.value; return { value: undefined } })
  on('ui.render', (api: any, e: any) => api.ui.resolve(e).Text({ children: ['base'] }))
  on('session.id', () => ({ value: 'test-session' }))
  on('command.list', () => ({ value: seen.commands ?? [] }))
  on('store.delete', (_api: unknown, e: { key: string }) => { delete seen.store[e.key]; return { value: undefined } })
  on('fs.exists',(_api: unknown, e: { path: string }) => {
    // The host resolves the path first: on Windows a POSIX path lands on the current drive (C:\home\...), on Linux a
    // Windows path is relative and lands under the working directory (/home/runner/.../C:/nope/...).
    const p = String(e.path).replace(/\\/g, '/')
    return { value: !(seen.missing || []).some((m) => p === m || p.endsWith(':' + m) || p.endsWith('/' + m)) }
  })
  on('model.fork', async (_api: unknown, e: { prompt: string }) => {
    if (seen.forkGate) await seen.forkGate
    if (seen.forkThrows) throw new Error('unknown method model.fork')
    seen.forkPrompt = e.prompt
    seen.forkCalls += 1
    return forkText === null
      ? { value: { isAnswered: false, reason: 'nothing-to-fork' } }
      : { value: { isAnswered: true, text: forkText } }
  })
  on('model.complete', () => {
    seen.haikuCalls += 1
    return haikuText === null
      ? { value: { isAnswered: false, reason: 'rate limited' } }
      : { value: { isAnswered: true, text: haikuText } }
  })
  on('prompt.read', () => ({ value: { text: seen.draft, cursor: seen.draft.length } }))
  // The editor's answer to a keystroke, and core's echo of a box change: both report the draft as it now stands.
  on('prompt.edit', () => ({ text: seen.draft, cursor: seen.draft.length }))
  on('prompt.change', (_api: unknown, e: { text: string }) => ({ text: e.text }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('prompt.fill', (_api: unknown, e: { text: string; mode?: string }) => {
    seen.draft = e.mode === 'append' ? seen.draft + e.text : e.text
    seen.fills.push(e.text)
    return { isFilled: true }
  })
}

const ANSWER = 'Đã sửa xong hàm parse và cập nhật file cấu hình theo yêu cầu, chưa chạy test nào cả.'
const THREE = 'VERIFY: Chạy lại toàn bộ test của thay đổi này\nNEXT: Xem diff của file cấu hình\nHANDOFF: Chuẩn bị mô tả PR cho nhánh hiện tại'
// The older tests assert the Vietnamese UI, so they pin it; the i18n tests start from an empty store (English default).
const fresh = (): Seen => ({ forkCalls: 0, haikuCalls: 0, draft: '', fills: [], store: { lang: 'vi' } })
const blank = (): Seen => ({ forkCalls: 0, haikuCalls: 0, draft: '', fills: [], store: {} })
const band = async ($: any) => JSON.stringify(await $.ui.render({ component: 'AbovePrompt', surface: 'terminal', props: {} }))
const start = ($: any) => $.session.start({ cwd: 'C:/Users/me' })

test('the session fork supplies the menu: tags, star on the first row, no transcript line', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  const r: any = await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(r?.text).toBeFalsy()
  const b = await band($)
  expect(b).toContain('1. [kiểm chứng] ★ Chạy lại toàn bộ test')
  expect(b).toContain('2. [bước tiếp] Xem diff của file cấu hình')
  expect(b).toContain('3. [bàn giao] Chuẩn bị mô tả PR')
  expect(b).toContain('Chèn tất cả 3 gợi ý')
  expect(seen.haikuCalls).toBe(0)
})

test('the count is not fixed: one suggestion gets no insert-all row', async ($, on) => {
  const seen = fresh()
  stubs(on, 'VERIFY: Chạy lại test của thay đổi này', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('1. [kiểm chứng] ★ Chạy lại test')
  expect(b).not.toContain('Chèn tất cả')
})

test('more than five lines are cut to five', async ($, on) => {
  const seen = fresh()
  const seven = Array.from({ length: 7 }, (_, i) => 'NEXT: Việc số ' + (i + 1) + ' của thay đổi này').join('\n')
  stubs(on, seven, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('5. [bước tiếp] Việc số 5')
  expect(b).not.toContain('6. ')
})

test('/fu 2 adds that prompt and the band stays, marked as used', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '2' })
  expect(seen.draft).toBe('Xem diff của file cấu hình')
  const b = await band($)
  expect(b).toContain('✓ 2. [bước tiếp] Xem diff')
  expect(b).toContain('1. [kiểm chứng] ★ Chạy lại toàn bộ test')
})

test('several picks accumulate in the draft and /fu all numbers them', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '1' })
  await $.command.run({ command: 'fu', args: '3' })
  expect(seen.draft).toBe('Chạy lại toàn bộ test của thay đổi này\nChuẩn bị mô tả PR cho nhánh hiện tại')
  // "all" only adds what is not in the box yet, so a prompt is never added twice.
  await $.command.run({ command: 'fu', args: 'all' })
  expect(seen.draft).toBe('Chạy lại toàn bộ test của thay đổi này\nChuẩn bị mô tả PR cho nhánh hiện tại\nXem diff của file cấu hình')
})

test('the insert-all button counts what is left and turns into a done line once every row is in', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  let b = await band($)
  expect(b).toContain('⏎ Chèn tất cả 3 gợi ý')
  expect(b).toContain('Gợi ý tiếp theo')
  await $.command.run({ command: 'fu', args: '1' })
  b = await band($)
  expect(b).toContain('⏎ Chèn 2 gợi ý còn lại')
  expect(b).not.toContain('Chèn tất cả')
  await $.command.run({ command: 'fu', args: '2 3' })
  b = await band($)
  expect(b).toContain('✓ Đã chèn tất cả 3 gợi ý')
  expect(b).toContain('Đã thêm hết 3 gợi ý vào ô nhập')
  expect(b).not.toContain('⏎ Chèn')
  expect(b).not.toContain('Gợi ý tiếp theo')
})

test('a sent menu moves into the history: a folded line, then /fu log shows what was sent and what was not', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '2' })
  await $.prompt.submit({ text: 'Xem diff của file cấu hình' })
  let b = await band($)
  expect(b).not.toContain('Gợi ý tiếp theo')
  expect(b).toContain('Gợi ý đã đưa (1 lượt, gần nhất: gửi 1/3)')
  await $.command.run({ command: 'fu', args: 'log' })
  b = await band($)
  expect(b).toContain('➤ 2. [bước tiếp] Xem diff')
  expect(b).toContain('· 1. [kiểm chứng] Chạy lại toàn bộ test')
  expect(b).toContain('Đóng lịch sử')
  await $.command.run({ command: 'fu', args: 'log' })
  b = await band($)
  expect(b).not.toContain('Đóng lịch sử')
  expect(b).toContain('Gợi ý đã đưa (1 lượt')
  expect((seen.store['band:test-session'] as any).history.length).toBe(1)
})

test('a row that was inserted but edited before sending is marked inserted, not sent', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '1' })
  await $.prompt.submit({ text: 'một câu hoàn toàn khác' })
  await $.command.run({ command: 'fu', args: 'log' })
  const b = await band($)
  expect(b).toContain('✎ 1. [kiểm chứng]')
  expect(b).toContain('gửi 0/3')
})

test('sending clears the box before prompt.submit runs: the inserted row still counts as sent', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '2' })
  // Real order seen in a --debug-file log on Enter: the box clear (prompt.change, empty) starts ~19 ms before prompt.submit.
  seen.draft = ''
  await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  await $.prompt.submit({ text: 'Xem diff của file cấu hình' })
  let b = await band($)
  expect(b).toContain('gửi 1/3')
  await $.command.run({ command: 'fu', args: 'log' })
  b = await band($)
  expect(b).toContain('➤ 2. [bước tiếp] Xem diff')
  expect(b).toContain('· 1. [kiểm chứng] Chạy lại toàn bộ test')
})

test('a row cleared from the box and then not sent is marked inserted, not sent', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '1' })
  seen.draft = ''
  await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  expect(await band($)).not.toContain('✓')
  await $.prompt.submit({ text: 'một câu hoàn toàn khác' })
  await $.command.run({ command: 'fu', args: 'log' })
  const b = await band($)
  expect(b).toContain('✎ 1. [kiểm chứng]')
  expect(b).toContain('gửi 0/3')
})

test('a menu replaced by a new turn without a submitted prompt is kept in the history too', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.turn.start({ turnId: 't2' })
  expect((seen.store['band:test-session'] as any).history.length).toBe(1)
  expect(await band($)).toContain('gửi 0/3')
})

test('/fu log with nothing saved says so; with a live band the folded history line stays out of the way', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  const r: any = await $.command.run({ command: 'fu', args: 'log' })
  expect(JSON.stringify(r)).toContain('chưa có gợi ý nào được lưu')
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.prompt.submit({ text: 'tiếp tục' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('Gợi ý tiếp theo')
  expect(b).not.toContain('Gợi ý đã đưa')
  await $.command.run({ command: 'fu', args: 'log' })
  expect(await band($)).toContain('Gợi ý đã đưa (mới nhất trước)')
})

test('the history survives a reload even when the band itself is too old to restore', async ($, on) => {
  const seen = fresh()
  seen.store['band:test-session'] = {
    at: Date.now() - 3 * 60 * 60 * 1000, enabled: true, recentUser: [], last: [], used: [],
    history: [{ at: Date.now() - 1000, items: [{ tag: 'NEXT', text: 'Thêm lệnh y', state: 'sent' }, { tag: 'VERIFY', text: 'Đọc lại file x', state: 'unused' }] }],
  }
  stubs(on, 'NONE', null, seen)
  expect(await band($)).toContain('Gợi ý đã đưa (1 lượt, gần nhất: gửi 1/2)')
})

test('/fu all on a fresh menu inserts a numbered list', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: 'all' })
  expect(seen.draft).toBe('1. Chạy lại toàn bộ test của thay đổi này\n2. Xem diff của file cấu hình\n3. Chuẩn bị mô tả PR cho nhánh hiện tại')
})

test('a submitted prompt clears the band', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.prompt.submit({ text: 'tiếp tục' })
  expect(await band($)).not.toContain('Chạy lại toàn bộ test')
})

test('silence is a valid outcome: NONE shows nothing and costs no fallback call', async ($, on) => {
  const seen = fresh()
  stubs(on, 'NONE', null, seen)
  await start($)
  const r: any = await $.turn.complete({ answer: ANSWER, durationMs: 500 })
  expect(r?.text).toBeFalsy()
  expect(await band($)).not.toContain('Gợi ý tiếp theo')
  expect(seen.haikuCalls).toBe(0)
})

test('drops placeholder/ellipsis lines and duplicates; untagged lines count as next step', async ($, on) => {
  const seen = fresh()
  stubs(on, 'NEXT: Mở file [đường dẫn] và sửa lỗi...\nChạy test\nNEXT: Chạy test\n"Xem diff"', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 500 })
  const b = await band($)
  expect(b).toContain('1. [bước tiếp] ★ Chạy test')
  expect(b).toContain('2. [bước tiếp] Xem diff')
  expect(b).not.toContain('3. ')
})

test('falls back to Haiku when the fork cannot answer', async ($, on) => {
  const seen = fresh()
  stubs(on, null, 'VERIFY: Chạy lại test của thay đổi này', seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 500 })
  expect(seen.forkCalls).toBe(1)
  expect(seen.haikuCalls).toBe(1)
  expect(await band($)).toContain('1. [kiểm chứng] ★ Chạy lại test')
})

test('reports a model failure visibly instead of failing silently', async ($, on) => {
  const seen = fresh()
  stubs(on, null, null, seen)
  await start($)
  const r: any = await $.turn.complete({ answer: ANSWER, durationMs: 500 })
  expect(r.text).toContain('model không trả lời')
  expect(r.text).toContain('rate limited')
})

test('ignores short answers, subagent turns and aborted turns', async ($, on) => {
  const seen = fresh()
  stubs(on, 'NEXT: x', 'NEXT: x', seen)
  await start($)
  await $.turn.complete({ answer: 'ok', durationMs: 10 })
  await $.turn.complete({ answer: 'x'.repeat(200), agentId: 'sub-1', durationMs: 10 })
  await $.turn.complete({ answer: 'y'.repeat(200), isAborted: true, durationMs: 10 })
  expect(seen.forkCalls + seen.haikuCalls).toBe(0)
})

test('/fu with nothing stored says so and fills nothing', async ($, on) => {
  const seen = fresh()
  stubs(on, 'NONE', null, seen)
  await start($)
  const r: any = await $.command.run({ command: 'fu', args: '1' })
  expect(r.text).toContain('chưa có gợi ý')
  expect(seen.fills).toEqual([])
})

test('unattended runs (claude -p) do not pay for a menu', async ($, on) => {
  const seen = fresh()
  seen.attended = '0'
  stubs(on, THREE, THREE, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkCalls + seen.haikuCalls).toBe(0)
  expect(await band($)).not.toContain('Gợi ý tiếp theo')
})

test('destructive or production-touching suggestions are kept and marked with a warning', async ($, on) => {
  const seen = fresh()
  const lines = [
    'NEXT: Chạy git push --force lên nhánh main',
    'NEXT: Xóa toàn bộ thư mục dist',
    'NEXT: Deploy bản này lên production',
    'VERIFY: Chạy lại test của thay đổi này',
  ].join('\n')
  stubs(on, lines, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('★ ⚠ Chạy git push --force lên nhánh main')
  expect(b).toContain('⚠ Xóa toàn bộ thư mục dist')
  expect(b).toContain('⚠ Deploy bản này lên production')
  expect(b).toContain('Chạy lại test của thay đổi này')
  expect(b).not.toContain('⚠ Chạy lại test')
  // The warning is display only: the text added to the input box has no mark.
  await $.command.run({ command: 'fu', args: '1' })
  expect(seen.draft).toBe('Chạy git push --force lên nhánh main')
})

test('/fu off clears the band and stops suggestions, /fu on resumes', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const off: any = await $.command.run({ command: 'fu', args: 'off' })
  expect(off.text).toContain('đã tắt')
  expect(await band($)).not.toContain('Gợi ý tiếp theo')
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkCalls).toBe(1)
  await $.command.run({ command: 'fu', args: 'on' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkCalls).toBe(2)
})

test('/fu hide folds the band into one line without touching the draft', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: 'hide' })
  const b = await band($)
  expect(b).not.toContain('Gợi ý tiếp theo')
  expect(b).not.toContain('Chạy lại toàn bộ test')
  expect(b).toContain('Gợi ý đang ẩn (3)')
  expect(b).toContain('/fu show')
  expect(seen.fills).toEqual([])
  expect((seen.store['band:test-session'] as any).collapsed).toBe(true)
})

test('/fu show brings a hidden band back with the same menu and check marks', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '2' })
  await $.command.run({ command: 'fu', args: 'hide' })
  await $.command.run({ command: 'fu', args: 'show' })
  const b = await band($)
  expect(b).toContain('Gợi ý tiếp theo')
  expect(b).toContain('✓ 2. [bước tiếp] Xem diff')
  expect(b).toContain('1. [kiểm chứng] ★ Chạy lại toàn bộ test')
  expect(b).not.toContain('Gợi ý đang ẩn')
})

test('picking from the keyboard while the band is hidden opens it again', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: 'hide' })
  await $.command.run({ command: 'fu', args: '1' })
  expect(seen.draft).toBe('Chạy lại toàn bộ test của thay đổi này')
  expect(await band($)).toContain('✓ 1. [kiểm chứng]')
})

test('a hidden band stays hidden across a reload, and a new turn or prompt drops it', async ($, on) => {
  const seen = fresh()
  seen.store['band:test-session'] = {
    at: Date.now(), enabled: true, collapsed: true, recentUser: [],
    last: [{ tag: 'VERIFY', text: 'Đọc lại file x' }, { tag: 'NEXT', text: 'Thêm lệnh y' }], used: [],
  }
  stubs(on, THREE, null, seen)
  expect(await band($)).toContain('Gợi ý đang ẩn (2)')
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('Gợi ý tiếp theo')
  expect(b).not.toContain('Gợi ý đang ẩn')
  await $.command.run({ command: 'fu', args: 'hide' })
  await $.prompt.submit({ text: 'tiếp tục' })
  const after = await band($)
  expect(after).not.toContain('Gợi ý đang ẩn')
  expect(after).not.toContain('Gợi ý tiếp theo')
})

test('/fu hide and /fu show with nothing to hide say so; /fu tells when the mod is off', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  const h: any = await $.command.run({ command: 'fu', args: 'hide' })
  expect(h.text).toContain('chưa có gợi ý')
  const s: any = await $.command.run({ command: 'fu', args: 'show' })
  expect(s.text).toContain('chưa có gợi ý')
  await $.command.run({ command: 'fu', args: 'off' })
  const bare: any = await $.command.run({ command: 'fu', args: '1' })
  expect(bare.text).toContain('/fu on')
})

test('computeTuning waits for data, then hides a rarely used NEXT/HANDOFF tag but never VERIFY', () => {
  expect(computeTuning({}).ready).toBe(false)
  expect(computeTuning({ shown: { NEXT: 5 } }, 0, 'vi').notes.join(' ')).toContain('chưa đủ dữ liệu')
  const t = computeTuning({ shown: { VERIFY: 12, NEXT: 12, HANDOFF: 12 }, used: { VERIFY: 0, NEXT: 0, HANDOFF: 6 } })
  expect(t.ready).toBe(true)
  expect(t.hideTags).toEqual(['NEXT'])
  expect(t.maxItems).toBe(5)
})

test('computeTuning caps the menu at 3 rows when nearly every pick is row 1 or 2', () => {
  const t = computeTuning({ shown: { VERIFY: 25 }, used: { VERIFY: 15 }, pos: { '0': 9, '1': 5, '3': 1 } })
  expect(t.maxItems).toBe(3)
  const wide = computeTuning({ shown: { VERIFY: 25 }, used: { VERIFY: 15 }, pos: { '0': 4, '1': 3, '3': 4, '4': 4 } })
  expect(wide.maxItems).toBe(5)
})

test('extractPaths finds absolute Windows paths and trims punctuation', () => {
  expect(extractPaths('Đọc lại C:/Users/me/dev/x.py, rồi C:\\tmp\\a.txt.')).toEqual(['C:/Users/me/dev/x.py', 'C:\\tmp\\a.txt'])
  expect(extractPaths('Chạy test của thay đổi này')).toEqual([])
})

test('a VERIFY row naming a missing path is dropped, a NEXT row is kept', async ($, on) => {
  const seen = fresh()
  seen.missing = ['C:/nope/missing.py']
  stubs(on, 'VERIFY: Đọc lại C:/nope/missing.py để xác nhận\nNEXT: Tạo file C:/nope/missing.py với nội dung mẫu\nVERIFY: Chạy lại test của thay đổi này', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).not.toContain('Đọc lại C:/nope')
  expect(b).toContain('[bước tiếp]')
  expect(b).toContain('[kiểm chứng]')
})

test('learned adjustments reach the model and are enforced locally', async ($, on) => {
  const seen = fresh()
  seen.store.stats = { shown: { VERIFY: 12, NEXT: 12, HANDOFF: 2 }, used: { VERIFY: 6, NEXT: 0 }, pos: {} }
  stubs(on, 'NEXT: Xem diff của file cấu hình\nVERIFY: Chạy lại test của thay đổi này', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkPrompt).toContain('do not output any NEXT line')
  const b = await band($)
  expect(b).toContain('1. [kiểm chứng] ★ Chạy lại test')
  expect(b).not.toContain('Xem diff')
})

test('/fu tune explains the state and /fu reset forgets it', async ($, on) => {
  const seen = fresh()
  seen.store.stats = { shown: { VERIFY: 12, NEXT: 12 }, used: { VERIFY: 6, NEXT: 0 }, pos: {} }
  stubs(on, 'NONE', null, seen)
  await start($)
  const tune: any = await $.command.run({ command: 'fu', args: 'tune' })
  expect(tune.text).toContain('ngừng đề xuất loại [bước tiếp]')
  const reset: any = await $.command.run({ command: 'fu', args: 'reset' })
  expect(reset.text).toContain('đã xóa thống kê')
})

test('a long absolute path does not make an otherwise short suggestion fail the length limit', async ($, on) => {
  const seen = fresh()
  const path = 'C:/Users/me/AppData/Local/Temp/claude/C--Users-me/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d/scratchpad/hello.py'
  stubs(on, 'VERIFY: Đọc lại file ' + path + ' để xác nhận nội dung, không chạy nó.', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(await band($)).toContain('hello.py')
})

test('forbiddenVerbs extracts what the user forbade and ignores filler words', () => {
  expect(forbiddenVerbs('Chỉ tạo file, KHÔNG chạy nó.')).toEqual(['chạy'])
  expect(forbiddenVerbs('đừng xóa gì, không được push, do not deploy, never merge')).toEqual(['xóa', 'push', 'deploy', 'merge'])
  expect(forbiddenVerbs('không cần giải thích')).toEqual(['giải'])
  expect(forbiddenVerbs('không có lỗi nào, không thể nào')).toEqual([])
  expect(forbiddenVerbs('Viết hàm parse')).toEqual([])
})

test('dropForbidden removes a suggestion that starts with a forbidden action only', () => {
  const items = [
    { tag: 'VERIFY', text: 'Chạy file C:/a/b.py và cho biết dòng nó in ra.' },
    { tag: 'VERIFY', text: 'Đọc lại file C:/a/b.py để xác nhận, không chạy nó.' },
  ]
  expect(dropForbidden(items, ['chạy']).map((i: any) => i.tag + i.text.slice(0, 6))).toEqual(['VERIFYĐọc lạ'])
  expect(dropForbidden(items, []).length).toBe(2)
})

test('the band never offers an action the user just forbade', async ($, on) => {
  const seen = fresh()
  const menu = ['VERIFY: Chạy file C:/a/demo.py và cho biết dòng nó in ra.', 'VERIFY: Đọc lại file C:/a/demo.py để xác nhận nội dung, không chạy nó.'].join('\n')
  stubs(on, menu, null, seen)
  await start($)
  await $.prompt.submit({ text: 'Tạo file C:/a/demo.py in xin chào. Chỉ tạo file, KHÔNG chạy nó.' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).not.toContain('Chạy file')
  expect(b).toContain('Đọc lại file')
  expect(seen.forkPrompt).toContain('NEVER suggest an action they forbade')
})

test('the fork is anchored on the latest user request and told to ignore leftovers', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.prompt.submit({ text: 'Viết file todo_cli.py quản lý việc cần làm' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkPrompt).toContain('latest request')
  expect(seen.forkPrompt).toContain('Viết file todo_cli.py')
  expect(seen.forkPrompt).toContain('left over from an earlier turn')
})

test('the band is mirrored into the store so a hot reload does not lose it', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const saved: any = seen.store['band:test-session']
  expect(saved.last.length).toBe(3)
  expect(saved.enabled).toBe(true)
  await $.command.run({ command: 'fu', args: '2' })
  expect((seen.store['band:test-session'] as any).used).toEqual([1])
  await $.prompt.submit({ text: 'tiếp tục' })
  expect((seen.store['band:test-session'] as any).last).toEqual([])
})

test('after a reload the saved band comes back, with its check marks', async ($, on) => {
  const seen = fresh()
  seen.draft = 'Đọc lại file x' // the checked row is still in the box, as in a hot reload
  seen.store['band:test-session'] = {
    at: Date.now(), enabled: true, recentUser: ['Viết file x'],
    last: [{ tag: 'VERIFY', text: 'Đọc lại file x' }, { tag: 'NEXT', text: 'Thêm lệnh y' }], used: [0],
  }
  stubs(on, 'NONE', null, seen)
  const b = await band($)
  expect(b).toContain('Gợi ý tiếp theo')
  expect(b).toContain('✓ 1. [kiểm chứng]')
  expect(b).toContain('2. [bước tiếp] Thêm lệnh y')
})

test('a band saved hours ago comes back after exit + resume, labelled with its age, and /fu off is remembered', async ($, on) => {
  const seen = fresh()
  seen.store['band:test-session'] = {
    at: Date.now() - 3 * 60 * 60 * 1000, enabled: false, recentUser: [],
    last: [{ tag: 'VERIFY', text: 'Đọc lại file x' }], used: [],
  }
  stubs(on, THREE, null, seen)
  await start($)
  const b = await band($)
  expect(b).toContain('1. [kiểm chứng] ★ Đọc lại file x')
  expect(b).toContain('từ lần trước, 3 giờ trước')
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkCalls).toBe(0)
})

test('a fresh menu drops the "from last time" label', async ($, on) => {
  const seen = fresh()
  seen.store['band:test-session'] = {
    at: Date.now() - 3 * 60 * 60 * 1000, enabled: true, recentUser: [],
    last: [{ tag: 'VERIFY', text: 'Đọc lại file x' }], used: [],
  }
  stubs(on, THREE, null, seen)
  await start($)
  expect(await band($)).toContain('từ lần trước')
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('Chạy lại toàn bộ test')
  expect(b).not.toContain('từ lần trước')
})

test('an unattended session (claude -p, helper runs) never takes a store slot', async ($, on) => {
  const seen = fresh()
  seen.attended = '0'
  stubs(on, THREE, null, seen)
  await start($)
  await $.prompt.submit({ text: 'You are a memory relevance compressor utility.' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.store['band:test-session']).toBeUndefined()
  expect(seen.store['bands']).toBeUndefined()
})

test('saving prunes records with nothing to restore and records older than 30 days, keeps real ones beyond 20', async ($, on) => {
  const seen = fresh()
  const day = 24 * 60 * 60 * 1000
  const index: string[] = []
  for (let i = 0; i < 30; i++) {
    const key = 'band:real-' + i
    seen.store[key] = { at: Date.now() - i * 60 * 1000, enabled: true, recentUser: [], last: [{ tag: 'VERIFY', text: 'Đọc lại file ' + i }], used: [], history: [] }
    index.push(key)
  }
  for (let i = 0; i < 10; i++) {
    const key = 'band:helper-' + i
    seen.store[key] = { at: Date.now(), enabled: true, recentUser: ['You are a memory relevance compressor utility.'], last: [], used: [], history: [] }
    index.push(key)
  }
  seen.store['band:ancient'] = { at: Date.now() - 31 * day, enabled: false, recentUser: [], last: [{ tag: 'VERIFY', text: 'cũ' }], used: [], history: [] }
  index.unshift('band:ancient')
  seen.store['bands'] = index
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const kept = seen.store['bands'] as string[]
  expect(kept).toContain('band:test-session')
  expect(kept.filter((k) => k.startsWith('band:real-')).length).toBe(30)
  expect(kept.some((k) => k.startsWith('band:helper-'))).toBe(false)
  expect(kept).not.toContain('band:ancient')
  expect(seen.store['band:helper-0']).toBeUndefined()
  expect(seen.store['band:ancient']).toBeUndefined()
})

test('dropOffTopic removes NEXT/HANDOFF rows about files the latest request never mentions, keeps VERIFY', () => {
  const latest = 'Viết file calc_cli.py kèm README_calc.md. KHÔNG chạy.'
  const items = [
    { tag: 'NEXT', text: 'Vá load trong C:/s/notes_cli.py để báo lỗi gọn' },
    { tag: 'HANDOFF', text: 'Cập nhật C:/s/README_notes.md' },
    { tag: 'NEXT', text: 'Thêm lệnh chia cho 0 vào C:/s/calc_cli.py' },
    { tag: 'VERIFY', text: 'Đọc lại C:/s/other_file.py để đối chiếu' },
    { tag: 'NEXT', text: 'Thêm trường mô tả cho mỗi lệnh' },
  ]
  expect(dropOffTopic(items, latest).map((i: any) => i.text.slice(0, 12))).toEqual(['Thêm lệnh ch', 'Đọc lại C:/s', 'Thêm trường '])
  expect(dropOffTopic(items, '').length).toBe(5)
})

test('answerListLines picks numbered and bulleted lines only', () => {
  const a = 'Kết quả:\n1. Chạy lại test\n- Xem diff\nHết.'
  expect(answerListLines(a)).toEqual(['Chạy lại test', 'Xem diff'])
})

test('a suggestion already listed in the answer is dropped, a different one is kept', () => {
  const answer = 'Còn lại:\n1. Chạy lại toàn bộ test của thay đổi này\n2. Cập nhật tài liệu hướng dẫn'
  const items = [
    { tag: 'VERIFY', text: 'Chạy lại toàn bộ test của thay đổi này' },
    { tag: 'NEXT', text: 'Xem diff của file cấu hình' },
  ]
  expect(dropCoveredByAnswer(items, answer).map((i: any) => i.text)).toEqual(['Xem diff của file cấu hình'])
  expect(dropCoveredByAnswer(items, 'Không có danh sách nào ở đây cả.').length).toBe(2)
})

test('a short suggestion is never dropped as a duplicate', () => {
  const items = [{ tag: 'VERIFY', text: 'Chạy lại test' }]
  expect(dropCoveredByAnswer(items, '1. Chạy lại test').length).toBe(1)
})

test('the band does not repeat steps the answer already lists', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  const answer = 'Đã sửa xong. Bước còn lại:\n1. Chạy lại toàn bộ test của thay đổi này\n2. Rà soát thêm phần cấu hình'
  await $.turn.complete({ answer, durationMs: 1000 })
  const b = await band($)
  expect(b).not.toContain('Chạy lại toàn bộ test')
  expect(b).toContain('Xem diff của file cấu hình')
})

test('/fu stats counts shown, used and silent turns', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '1' })
  const r: any = await $.command.run({ command: 'fu', args: 'stats' })
  expect(r.text).toContain('đã hiện 3 gợi ý')
  expect(r.text).toContain('bạn dùng 1')
  expect(r.text).toContain('kiểm chứng 1/1')
})

test('after exit + resume the saved check marks are dropped when the input box is empty, so rows are clickable again', async ($, on) => {
  const seen = fresh() // draft is empty: a new process starts with an empty box
  seen.store['band:test-session'] = {
    at: Date.now(), enabled: true, recentUser: [],
    last: [{ tag: 'NEXT', text: 'Viết đặc tả cho module dich/ngon_ngu' }, { tag: 'NEXT', text: 'Viết đặc tả cho module dich/srt_utils' }], used: [0, 1],
  }
  stubs(on, 'NONE', null, seen)
  const b = await band($)
  expect(b).not.toContain('✓')
  expect(b).toContain('Chèn tất cả 2 gợi ý')
  await $.command.run({ command: 'fu', args: 'all' })
  expect(seen.draft).toBe('1. Viết đặc tả cho module dich/ngon_ngu\n2. Viết đặc tả cho module dich/srt_utils')
})

test('a hot reload keeps the check marks of rows that are still in the box', async ($, on) => {
  const seen = fresh()
  seen.draft = 'Viết đặc tả cho module dich/ngon_ngu'
  seen.store['band:test-session'] = {
    at: Date.now(), enabled: true, recentUser: [],
    last: [{ tag: 'NEXT', text: 'Viết đặc tả cho module dich/ngon_ngu' }, { tag: 'NEXT', text: 'Viết đặc tả cho module dich/srt_utils' }], used: [0, 1],
  }
  stubs(on, 'NONE', null, seen)
  const b = await band($)
  expect(b).toContain('✓ 1. [bước tiếp]')
  expect(b).not.toContain('✓ 2.')
})

test('a checked row whose text left the box is added again on /fu, without counting as a second use', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '2' })
  expect(seen.draft).toBe('Xem diff của file cấu hình')
  await $.command.run({ command: 'fu', args: '2' }) // still in the box: nothing is added twice
  expect(seen.draft).toBe('Xem diff của file cấu hình')
  seen.draft = '' // the user cleared the box
  await $.command.run({ command: 'fu', args: '2' })
  expect(seen.draft).toBe('Xem diff của file cấu hình')
  expect(((seen.store.stats as any).used || {}).NEXT).toBe(1)
})

test('a check mark survives extra spaces the user typed inside the row text', async ($, on) => {
  const seen = fresh()
  seen.draft = 'Viết  đặc tả   cho module dich/ngon_ngu'
  seen.store['band:test-session'] = {
    at: Date.now(), enabled: true, recentUser: [],
    last: [{ tag: 'NEXT', text: 'Viết đặc tả cho module dich/ngon_ngu' }], used: [0],
  }
  stubs(on, 'NONE', null, seen)
  expect(await band($)).toContain('✓ 1. [bước tiếp]')
})

test('a menu that finishes after the user already sent the next prompt is thrown away', async ($, on) => {
  const seen = fresh()
  let release: () => void = () => {}
  seen.forkGate = new Promise<void>((resolve) => { release = resolve })
  stubs(on, THREE, null, seen)
  await start($)
  const pending = $.turn.complete({ answer: ANSWER, durationMs: 1000 }) // the fork is still thinking...
  await $.prompt.submit({ text: 'một câu hoàn toàn khác' }) // ...and the user moves on
  release()
  await pending
  const b = await band($)
  expect(b).not.toContain('kiểm chứng')
  expect(b).not.toContain('Gợi ý tiếp theo')
})

test('a slash command typed while the menu is being written does not throw it away', async ($, on) => {
  const seen = fresh()
  let release: () => void = () => {}
  seen.forkGate = new Promise<void>((resolve) => { release = resolve })
  stubs(on, THREE, null, seen)
  await start($)
  const pending = $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.prompt.submit({ text: '/fu stats', command: 'fu' })
  release()
  await pending
  expect(await band($)).toContain('kiểm chứng')
})

const SESSION_COMMANDS = [
  { name: 'code-review', description: 'Review the current diff for correctness bugs', source: 'skill' },
  { name: 'lark-calendar', description: 'Calendar events and meeting rooms', source: 'plugin' },
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  { name: 'fu', description: 'Follow-up prompts', source: 'plugin' },
  { name: 'bad name', description: 'has a space', source: 'plugin' },
]

test('pickSkills lists only commands that share words with the context, never built-ins or /fu', () => {
  const lines = pickSkills(SESSION_COMMANDS, 'Please review the diff before the merge').split('\n')
  expect(lines).toEqual(['/code-review: Review the current diff for correctness bugs'])
  expect(pickSkills(SESSION_COMMANDS, 'completely unrelated words here')).toBe('')
  expect(pickSkills(SESSION_COMMANDS, 'clear conversation follow prompts')).toBe('')
})

test('pickSkills keeps at most 25 lines and cleans descriptions', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: 'review-' + i, description: 'review\u001b[31m thing​ ' + 'x'.repeat(300), source: 'skill' }))
  const out = pickSkills(many, 'review').split('\n')
  expect(out.length).toBe(25)
  expect(out[0]).not.toContain('\u001b')
  expect(out[0]).not.toContain('​')
  expect(out[0].length).toBeLessThan(140)
  expect(cleanText('a\n\n  b\u0007', 10)).toBe('a b')
})

test('dropUnknownCommands drops an invented /name, keeps real ones, paths and prose', () => {
  const known = knownCommandNames(SESSION_COMMANDS)
  const items = [
    { tag: 'NEXT', text: '/code-review high' },
    { tag: 'NEXT', text: '/invented-skill do things' },
    { tag: 'VERIFY', text: '/c/Users/x/file.txt đọc lại' },
    { tag: 'NEXT', text: 'Xem diff' },
  ]
  expect(dropUnknownCommands(items, known).map((i) => i.text)).toEqual(['/code-review high', '/c/Users/x/file.txt đọc lại', 'Xem diff'])
  expect(dropUnknownCommands(items, null)).toHaveLength(4)
})

test('the fork is told about the relevant skills, and a suggestion naming a command the session lacks is dropped', async ($, on) => {
  const seen = fresh()
  seen.commands = SESSION_COMMANDS
  stubs(on, 'NEXT: /code-review high\nNEXT: /invented-skill chạy thử\nVERIFY: Xem diff của file cấu hình', null, seen)
  await start($)
  await $.prompt.submit({ text: 'Sửa hàm parse rồi cho tôi review diff' })
  await $.turn.complete({ answer: ANSWER + ' Cần review diff trước khi merge.', durationMs: 1000 })
  expect(seen.forkPrompt).toContain('<available-skills>')
  expect(seen.forkPrompt).toContain('/code-review: Review the current diff')
  expect(seen.forkPrompt).not.toContain('/lark-calendar')
  const b = await band($)
  expect(b).toContain('/code-review high')
  expect(b).not.toContain('invented-skill')
  expect(b).toContain('Xem diff của file cấu hình')
})

test('with no readable command list the mod still suggests and drops nothing', async ($, on) => {
  const seen = fresh() // command.list answers []: treated as unreadable
  stubs(on, 'NEXT: /anything goes\nVERIFY: Xem diff của file cấu hình', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkPrompt).not.toContain('<available-skills>')
  const b = await band($)
  expect(b).toContain('/anything goes')
})

test('/fu stats counts skill rows: turns offered, rows shown, rows used', async ($, on) => {
  const seen = fresh()
  seen.commands = SESSION_COMMANDS
  stubs(on, 'NEXT: /code-review high\nVERIFY: Xem diff của file cấu hình', null, seen)
  await start($)
  await $.prompt.submit({ text: 'Sửa hàm parse rồi cho tôi review diff' })
  await $.turn.complete({ answer: ANSWER + ' Cần review diff trước khi merge.', durationMs: 1000 })
  let r: any = await $.command.run({ command: 'fu', args: 'stats' })
  expect(r.text).toContain('mô tả cho model 1 lượt, hiện 1 dòng, dùng 0')
  await $.command.run({ command: 'fu', args: '1' })
  r = await $.command.run({ command: 'fu', args: 'stats' })
  expect(r.text).toContain('mô tả cho model 1 lượt, hiện 1 dòng, dùng 1')
})

test('computeTuning: a manual row count replaces the automatic cap and is reported', () => {
  const stats = { shown: { VERIFY: 30, NEXT: 30 }, used: { VERIFY: 20, NEXT: 20 }, pos: { '0': 30, '1': 10, '2': 0 } }
  expect(computeTuning(stats).maxItems).toBe(3)
  const t = computeTuning(stats, 5, 'vi')
  expect(t.maxItems).toBe(5)
  expect(t.notes.join(' ')).toContain('bạn đặt tối đa 5 dòng')
  expect(computeTuning(stats, 0).maxItems).toBe(3)
  expect(computeTuning(stats, 9).maxItems).toBe(3)
  expect(computeTuning({}, 2).maxItems).toBe(5)
})

test('/fu rows N sets the row cap, /fu rows auto clears it, bad input explains', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  let r: any = await $.command.run({ command: 'fu', args: 'rows 5' })
  expect(r.text).toContain('tối đa 5 dòng')
  expect(seen.store.rows).toBe(5)
  r = await $.command.run({ command: 'fu', args: 'rows 9' })
  expect(r.text).toContain('/fu rows 1-5')
  expect(seen.store.rows).toBe(5)
  r = await $.command.run({ command: 'fu', args: 'rows auto' })
  expect(r.text).toContain('tự động')
  expect(seen.store.rows).toBeUndefined()
})

test('the row cap set with /fu rows reaches the model prompt', async ($, on) => {
  const seen = fresh()
  seen.store.stats = { shown: { VERIFY: 30 }, used: { VERIFY: 20 }, pos: { '0': 30 } }
  stubs(on, THREE, null, seen)
  await start($)
  await $.command.run({ command: 'fu', args: 'rows 2' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkPrompt).toContain('Output at most 2 lines.')
  const b = await band($)
  expect(b).toContain('2. [')
  expect(b).not.toContain('3. [')
})

// ---- i18n (2.0) ---------------------------------------------------------------------------------------------------

test('i18n: with no language set and no prompt yet the UI is English', async ($, on) => {
  const seen = blank()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('Suggested next')
  expect(b).toContain('1. [verify] ★ Chạy lại toàn bộ test')
  expect(b).toContain('2. [next]')
  expect(b).toContain('3. [handoff]')
  expect(b).toContain('Insert all 3')
  expect(b).not.toContain('Gợi ý tiếp theo')
})

test('i18n: auto mode follows the language of the latest prompt', async ($, on) => {
  const seen = blank()
  stubs(on, THREE, null, seen)
  await start($)
  await $.prompt.submit({ text: 'Sửa hàm parse và cập nhật file cấu hình giúp tôi' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  let b = await band($)
  expect(b).toContain('Gợi ý tiếp theo')
  expect(b).toContain('[kiểm chứng]')
  await $.prompt.submit({ text: 'Now fix the parser and update the config file' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  b = await band($)
  expect(b).toContain('Suggested next')
  expect(b).toContain('[verify]')
})

test('i18n: /fu lang vi|en pins the language, /fu lang auto clears it, bad input explains', async ($, on) => {
  const seen = blank()
  stubs(on, THREE, null, seen)
  await start($)
  let r: any = await $.command.run({ command: 'fu', args: 'lang vi' })
  expect(seen.store['lang']).toBe('vi')
  expect(r.text).toContain('tiếng Việt')
  await $.prompt.submit({ text: 'Now fix the parser and update the config file' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(await band($)).toContain('Gợi ý tiếp theo')
  r = await $.command.run({ command: 'fu', args: 'lang en' })
  expect(seen.store['lang']).toBe('en')
  expect(r.text).toContain('English')
  expect(await band($)).toContain('Suggested next')
  r = await $.command.run({ command: 'fu', args: 'lang auto' })
  expect(seen.store['lang']).toBeUndefined()
  r = await $.command.run({ command: 'fu', args: 'lang fr' })
  expect(r.text).toContain('/fu lang en')
})

test('i18n: the detected language is remembered, so a resumed session with no new prompt keeps it', async ($, on) => {
  const seen = blank()
  seen.store['lastLang'] = 'vi'
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(await band($)).toContain('Gợi ý tiếp theo')
})

test('i18n: a Vietnamese prompt updates the remembered language', async ($, on) => {
  const seen = blank()
  stubs(on, 'NONE', null, seen)
  await start($)
  await $.prompt.submit({ text: 'Kiểm tra lại giúp tôi' })
  expect(seen.store['lastLang']).toBe('vi')
  await $.prompt.submit({ text: 'Check it again please' })
  expect(seen.store['lastLang']).toBe('en')
})

test('i18n: an English background-task notification does not change the remembered language', async ($, on) => {
  // Seen in real use: a "Background command ... completed" notification arrives as prompt.submit and flipped a
  // Vietnamese user's band to English.
  const seen = blank()
  stubs(on, THREE, null, seen)
  await start($)
  await $.prompt.submit({ text: 'Kiểm tra lại giúp tôi', origin: { kind: 'composer' } })
  expect(seen.store['lastLang']).toBe('vi')
  const recent = () => (seen.store['band:test-session'] as { recentUser?: string[] } | undefined)?.recentUser ?? []
  expect(recent()).toContain('Kiểm tra lại giúp tôi')
  const note = 'Background command "Wait for the CI run" completed (exit code 0)'
  await $.prompt.submit({ text: note, isMeta: true, origin: { kind: 'task-notification' } })
  // One diff for both effects: the remembered language, and the recent prompts used to respect what the user forbade.
  expect({ lastLang: seen.store['lastLang'], notificationInRecent: recent().includes(note) })
    .toEqual({ lastLang: 'vi', notificationInRecent: false })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(await band($)).toContain('Gợi ý tiếp theo')
})

test('i18n: a one-row menu that is in the input box reads as one suggestion in English', async ($, on) => {
  const seen = blank()
  stubs(on, 'VERIFY: Run the tests for this change', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: '1' })
  const b = await band($)
  expect(b).toContain('The suggestion is in the input box')
  expect(b).not.toContain('All 1 suggestions')
})

test('a notification turn keeps the band on screen; a menu it writes moves the old one into the history', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.prompt.submit({ text: 'Background command "build" completed (exit code 0)', isMeta: true, origin: { kind: 'task-notification' } })
  await $.turn.start({ turnId: 't-note' })
  let b = await band($)
  expect(b).toContain('1. [kiểm chứng] ★ Chạy lại toàn bộ test')
  expect(b).not.toContain('Gợi ý đã đưa')
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const r: any = await $.command.run({ command: 'fu', args: 'log' })
  expect(r?.text ?? '').not.toContain('chưa có gợi ý nào')
  b = await band($)
  expect(b).toContain('gửi 0/3')
})

test('i18n: English replies for /fu commands and stats', async ($, on) => {
  const seen = blank()
  stubs(on, THREE, null, seen)
  await start($)
  let r: any = await $.command.run({ command: 'fu', args: '' })
  expect(r.text).toContain('no suggestions yet')
  r = await $.command.run({ command: 'fu', args: 'stats' })
  expect(r.text).toContain('shown 0 suggestions')
  r = await $.command.run({ command: 'fu', args: 'off' })
  expect(r.text).toContain('/fu on')
  expect(r.text).not.toContain('tắt')
})

test('i18n: a restored old band says how old it is, in English', async ($, on) => {
  const seen = blank()
  seen.store['band:test-session'] = {
    at: Date.now() - 3 * 60 * 60 * 1000, enabled: true, recentUser: ['Check the parser'],
    last: [{ tag: 'VERIFY', text: 'Read back the parser file' }], used: [],
  }
  stubs(on, 'NONE', null, seen)
  await start($)
  const b = await band($)
  expect(b).toContain('from last time, 3 hours ago')
  expect(b).toContain('[verify] ★ Read back the parser file')
})

test('i18n: computeTuning notes are English by default', () => {
  expect(computeTuning({ shown: { NEXT: 5 } }).notes.join(' ')).toContain('not enough data')
  const stats = { shown: { VERIFY: 30, NEXT: 30 }, used: { VERIFY: 20, NEXT: 20 }, pos: { '0': 30, '1': 10, '2': 0 } }
  expect(computeTuning(stats, 5).notes.join(' ')).toContain('you set at most 5 rows')
})

test('i18n: every English and Vietnamese string table has the same keys', () => {
  expect(Object.keys(STRINGS.en).sort()).toEqual(Object.keys(STRINGS.vi).sort())
})

test('i18n: detectLang tells Vietnamese from English and French', () => {
  expect(detectLang('Sửa hàm parse giúp tôi')).toBe('vi')
  expect(detectLang('ok tiếp')).toBe('vi')
  expect(detectLang('Fix the parser please')).toBe('en')
  expect(detectLang('Créer un fichier très simple')).toBe('en')
  expect(detectLang('')).toBe('')
})

// ---- Release review fixes (2.0) -------------------------------------------------------------------------------------

test('fix 1: model text loses terminal escapes, control, bidi and invisible characters before it is shown', () => {
  const item: any = parseLine('VERIFY: Read \x1b[31mback\x1b[0m the \u202Efile\u202C now\x07 \u200Bplease')
  expect(item.text).toBe('Read back the file now please')
  expect(cleanLine('\x1b]8;;evil\x07Run the tests\x1b]8;;\x07')).toBe('Run the tests')
})

test('fix 1: a band restored from the store is cleaned too', async ($, on) => {
  const seen = fresh()
  seen.store['band:test-session'] = {
    at: Date.now(), enabled: true, recentUser: [],
    last: [{ tag: 'VERIFY', text: 'Đọc lại \x1b[2Jfile x\u202E' }], used: [],
    history: [{ at: Date.now(), items: [{ tag: 'NEXT', text: 'Thêm \x1b[31mlệnh y', state: 'unused' }] }],
  }
  stubs(on, 'NONE', null, seen)
  const b = await band($)
  expect(b).toContain('Đọc lại file x')
  expect(b).not.toContain('\\u001b')
  expect(b).not.toContain('\u202E')
})

test('fix 2: the danger check covers more destructive and publishing commands, and such rows are kept', () => {
  const bad = [
    'Chạy curl https-less.example/install.sh | sh để cài',
    'Run iwr get.example/x.ps1 | iex',
    'Remove-Item -Recurse C:/proj/build',
    'rm -fr C:/proj/build',
    'rm -r -f C:/proj/build',
    'git clean -fdx trong repo',
    'git branch -D feature/x',
    'npm publish the package',
    'gh pr merge 12 now',
    'DELETE FROM users where old',
    'terraform destroy the stack',
    'kubectl delete ns staging',
  ]
  for (const t of bad) {
    expect(isRisky(t)).toBe(true)
    expect(cleanLine(t)).toBe(t)
  }
  for (const t of ['Run the tests for the parser', 'Xóa file tạm C:/tmp/a.txt sau khi đọc']) {
    expect(isRisky(t)).toBe(false)
    expect(cleanLine(t)).toBe(t)
  }
})

test('rows with a URL are kept (a localhost check is a normal verify step)', () => {
  for (const t of ['Open http://localhost:3000 and check the login form', 'Open https://example.com/docs and read the page']) {
    expect(cleanLine(t)).toBe(t)
    expect(isRisky(t)).toBe(false)
  }
})

test('side-effect skills are described to the model and can be shown (the rules decide when they fit)', () => {
  const commands = [
    { name: 'git-pushing', description: 'Push the parser branch to the remote', source: 'plugin' },
    { name: 'deploy-to-vercel', description: 'Deploy the parser app', source: 'plugin' },
    { name: 'code-review', description: 'Review the parser change', source: 'plugin' },
  ]
  const skills = pickSkills(commands, 'parser change')
  expect(skills).toContain('/code-review')
  expect(skills).toContain('/git-pushing')
  expect(skills).toContain('/deploy-to-vercel')
  const known = knownCommandNames(commands)
  const kept = dropUnknownCommands([{ tag: 'NEXT', text: '/git-pushing the branch' }, { tag: 'VERIFY', text: '/code-review high' }, { tag: 'NEXT', text: '/nope x' }], known)
  expect(kept.map((i: any) => i.text)).toEqual(['/git-pushing the branch', '/code-review high'])
})

test('API routes are not file paths; POSIX paths under known roots and msys drives still are', () => {
  expect(extractPaths('Call GET /api/users/1 and check the 200 status')).toEqual([])
  expect(extractPaths('Add pagination to the /v2/orders/list endpoint')).toEqual([])
  expect(extractPaths('Read /home/me/app/src/parser.ts')).toEqual(['/home/me/app/src/parser.ts'])
  expect(extractPaths('Read /Users/me/notes/a.md and /tmp/out/run.log')).toEqual(['/Users/me/notes/a.md', '/tmp/out/run.log'])
  expect(extractPaths('Read /c/Users/x/a.txt')).toEqual(['/c/Users/x/a.txt'])
  const next = [{ tag: 'NEXT', text: 'Add pagination to /api/users/1 in the handler' }]
  expect(dropOffTopic(next, 'add the users endpoint')).toEqual(next)
})

test('a VERIFY row naming an API route is kept', async ($, on) => {
  const seen = fresh()
  seen.missing = ['/api/users/1']
  stubs(on, 'VERIFY: Call GET /api/users/1 and check the 200 status', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(await band($)).toContain('/api/users/1')
})

test('the danger check leaves prose "Delete from" and safe git branch -d unmarked, still marks -D and SQL deletes', () => {
  const safe = [
    'Delete from the list the duplicate entry in C:/x/notes.md',
    'Add a test for git branch -d behaviour in the helper',
    'Run git branch -d feature/x after the merge',
  ]
  for (const t of safe) expect(isRisky(t)).toBe(false)
  const risky = ['Run git branch -D feature/x', 'Run DELETE FROM users WHERE id = 3', 'Run delete from users where id = 3', 'Run delete from sessions;']
  for (const t of risky) expect(isRisky(t)).toBe(true)
})

test('short routes under a known root or a single letter are not file paths; real files there still are', () => {
  for (const t of ['Call GET /v/1 and check the status', 'Open the /x/settings page', 'Open /home/dashboard after login', 'Call /a/b']) {
    expect(extractPaths(t)).toEqual([])
  }
  expect(extractPaths('Read /d/data/x.csv')).toEqual(['/d/data/x.csv'])
  expect(extractPaths('Read /c/Users/x/a.ts')).toEqual(['/c/Users/x/a.ts'])
  expect(extractPaths('Read /tmp/out.log and /etc/hosts.conf')).toEqual(['/tmp/out.log', '/etc/hosts.conf'])
  expect(extractPaths('Read /home/me/app')).toEqual(['/home/me/app'])
  expect(extractPaths('Read /root/.bashrc')).toEqual(['/root/.bashrc'])
})

test('force branch deletes are marked in every spelling, safe ones are not', () => {
  for (const t of ['Run git branch -d -f feature/x', 'Run git branch -df feature/x', 'Run git branch -fd feature/x',
    'Run git -C repo branch -D feature/x', 'Run git --no-pager branch -D x', 'Run git branch --delete --force x',
    // --delete with a short -f (no "--force" for the generic pattern to catch): only forceDeletesBranch marks it.
    'Run git branch --delete -f x',
    // Every git command in the row counts, not only the first.
    'Run git branch -a, then git branch -D x', 'Run git branch -vv; git branch -D x',
    // Global options written as --name=value.
    'Run git --git-dir=/r/x branch -D y', 'Run git --work-tree=C:/r branch -D y',
    // A quoted option value with spaces.
    'Run git -C "C:/my repo" branch -D old-parser', "Run git -C '/home/me/my repo' branch -D x"]) {
    expect(isRisky(t)).toBe(true)
  }
  for (const t of ['Run git branch -d feature/x after the merge', 'Run git branch -a, then build with gcc -D DEBUG', 'Run git -C repo branch -d x']) {
    expect(isRisky(t)).toBe(false)
  }
})

test('fix 3: /fu off stops recording prompts', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.command.run({ command: 'fu', args: 'off' })
  await $.prompt.submit({ text: 'Đây là một prompt có mật khẩu bí mật 1234' })
  const saved: any = seen.store['band:test-session']
  expect(saved.enabled).toBe(false)
  expect(JSON.stringify(saved.recentUser)).not.toContain('1234')
})

test('fix 3: /fu forget deletes every stored session, keeps statistics and settings', async ($, on) => {
  const seen = fresh()
  seen.store['band:other'] = { at: Date.now(), enabled: true, recentUser: ['secret prompt'], last: [{ tag: 'VERIFY', text: 'x' }], used: [], history: [] }
  seen.store['bands'] = ['band:other']
  seen.store['stats'] = { shown: { VERIFY: 3 } }
  seen.store['rows'] = 2
  stubs(on, THREE, null, seen)
  await start($)
  await $.prompt.submit({ text: 'Sửa hàm parse' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.store['band:test-session']).toBeDefined()
  const statsBefore = JSON.stringify(seen.store['stats'])
  const r: any = await $.command.run({ command: 'fu', args: 'forget' })
  expect(r.text).toContain('2')
  expect(seen.store['band:other']).toBeUndefined()
  expect(seen.store['band:test-session']).toBeUndefined()
  expect(seen.store['bands']).toBeUndefined()
  expect(JSON.stringify(seen.store['stats'])).toBe(statsBefore)
  expect(seen.store['rows']).toBe(2)
  expect(await band($)).not.toContain('Gợi ý tiếp theo')
})

test('fix 4: when session.surfaces is unavailable (older Claude Code) no model is called', async ($, on) => {
  const seen = fresh()
  seen.attended = 'throw'
  stubs(on, THREE, THREE, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.forkCalls + seen.haikuCalls).toBe(0)
})

test('fix 4: a missing model.fork API does not fall back to a paid Haiku call every turn', async ($, on) => {
  const seen = fresh()
  seen.forkThrows = true
  stubs(on, THREE, THREE, seen)
  await start($)
  const r: any = await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.haikuCalls).toBe(0)
  expect(String(r?.text)).toContain('Claude Code')
  const again: any = await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  expect(seen.haikuCalls).toBe(0)
  expect(again?.text).toBeFalsy()
})

test('fix 5: POSIX and home paths are found; slash commands, URLs and Windows paths are not mistaken for them', () => {
  expect(extractPaths('Read /home/me/app/src/parser.ts and ~/notes/todo.md, then /code-review')).toEqual(['/home/me/app/src/parser.ts', '~/notes/todo.md'])
  expect(extractPaths('C:/Users/x/a.txt')).toEqual(['C:/Users/x/a.txt'])
  expect(extractPaths('see a/b/c.txt')).toEqual([])
})

test('fix 5: a long POSIX path does not count toward the length limit', () => {
  const longPath = '/home/me/projects/' + 'very-long-folder-name/'.repeat(8) + 'parser.ts'
  const text = 'Read back ' + longPath + ' and confirm the export list matches the spec'
  expect(cleanLine(text)).toBe(text)
})

test('fix 5: msys drive paths are checked as Windows paths, home paths are not probed', () => {
  expect(existsTarget('/c/Users/x/file.txt')).toBe('C:/Users/x/file.txt')
  expect(existsTarget('/home/me/a.txt')).toBe('/home/me/a.txt')
  expect(existsTarget('~/a.txt')).toBe('')
  expect(existsTarget('C:/x/a.txt')).toBe('C:/x/a.txt')
})

test('fix 5: a VERIFY row naming a missing POSIX path is dropped', async ($, on) => {
  const seen = fresh()
  seen.missing = ['/home/me/app/missing.ts']
  stubs(on, 'VERIFY: Read back /home/me/app/missing.ts\nVERIFY: Read back /home/me/app/parser.ts', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('/home/me/app/parser.ts')
  expect(b).not.toContain('missing.ts')
})

test('a three-segment route is not dropped as a missing path when its first two segments do not exist either', async ($, on) => {
  const seen = fresh()
  seen.missing = ['/home/settings/profile', '/home/settings', 'V:/1/users', 'V:/1', '/home/me/app/gone.ts']
  stubs(on, 'VERIFY: Open /home/settings/profile and check the Save button\nVERIFY: Call /v/1/users and check the list\nVERIFY: Read back /home/me/app/gone.ts', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('/home/settings/profile')
  expect(b).toContain('/v/1/users')
  expect(b).not.toContain('gone.ts')
})

test('a check mark goes away as soon as its text leaves the input box (cleared or edited away)', async ($, on) => {
  const seen = fresh()
  stubs(on, THREE, null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.command.run({ command: 'fu', args: 'all' })
  expect(await band($)).toContain('Đã thêm hết 3 gợi ý')
  // Esc Esc / a stash empties the box: core raises prompt.change with kind "clear".
  seen.draft = ''
  await $.prompt.change({ text: '', cursor: 0, origin: { kind: 'clear' } })
  let b = await band($)
  expect(b).not.toContain('✓')
  expect(b).toContain('Chèn tất cả 3 gợi ý')
  // Ctrl+U or Backspace is an edit: only the row whose text left the box loses its mark.
  await $.command.run({ command: 'fu', args: '1 2' })
  expect(await band($)).toContain('✓ 1.')
  seen.draft = '1. Chạy lại toàn bộ test của thay đổi này'
  await $.prompt.edit({ origin: { kind: 'person' }, text: seen.draft + '\n2. Xem diff', cursor: 0, start: 0, end: 0, inputText: '' })
  b = await band($)
  expect(b).toContain('✓ 1.')
  expect(b).not.toContain('✓ 2.')
})

test('a one-row menu does not offer /fu 1 3 or /fu all in its footer', async ($, on) => {
  const seen = fresh()
  stubs(on, 'VERIFY: Chạy lại test của thay đổi này', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const one = await band($)
  expect(one).toContain('Ẩn gợi ý · /fu 1 · /fu show')
  expect(one).not.toContain('/fu 1 3')
  expect(one).not.toContain('/fu all')
})

test('discarding uncommitted work is marked, safe checkout/restore/stash commands are not', () => {
  const risky = ['Chạy git checkout -- . để bỏ mọi thay đổi', 'Run git checkout . to start over', 'Run git restore src/app.ts', 'Run git restore .', 'Run git stash drop', 'Run git stash clear']
  const safe = ['Run git checkout -b feature/login', 'Run git checkout main', 'Run git restore --staged src/app.ts', 'Run git stash list', 'Run git stash pop', 'Restore the deleted test from the last commit']
  for (const t of risky) expect([t, isRisky(t)]).toEqual([t, true])
  for (const t of safe) expect([t, isRisky(t)]).toEqual([t, false])
})

test('the history panel marks a risky row with a warning too', async ($, on) => {
  const seen = fresh()
  stubs(on, 'NEXT: Chạy git push --force lên nhánh main\nVERIFY: Chạy lại toàn bộ test của thay đổi này', null, seen)
  await start($)
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  await $.prompt.submit({ text: 'tiếp tục việc khác' })
  await $.command.run({ command: 'fu', args: 'log' })
  const b = await band($)
  expect(b).toContain('· 1. [bước tiếp] ⚠ Chạy git push --force')
  expect(b).toContain('· 2. [kiểm chứng] Chạy lại toàn bộ test')
})

test('a VERIFY row about a path the turn already read back is dropped; unread paths and NEXT rows are kept', async ($, on) => {
  const seen = fresh()
  stubs(on, 'VERIFY: Read back C:/Users/me/app/config.json and confirm the port\nVERIFY: Read back C:/Users/me/app/other.json\nNEXT: Add a comment to C:/Users/me/app/config.json', null, seen)
  await start($)
  await $.prompt.submit({ text: 'set the port in C:/Users/me/app/config.json' })
  await $.turn.start({ turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Users\\me\\app\\config.json', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\Users\\me\\app\\config.json' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).not.toContain('confirm the port')
  expect(b).toContain('1. [kiểm chứng] ★ Read back C:/Users/me/app/other.json')
  expect(b).toContain('2. [bước tiếp] Add a comment to C:/Users/me/app/config.json')
})

test('a read before the last edit of that file, a read in an earlier turn or in a subagent does not count', async ($, on) => {
  const seen = fresh()
  stubs(on, 'VERIFY: Read back C:/Users/me/app/a.ts\nVERIFY: Read back C:/Users/me/app/b.ts\nVERIFY: Read back C:/Users/me/app/c.ts', null, seen)
  await start($)
  await $.turn.start({ turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/Users/me/app/b.ts' })
  await $.turn.start({ turnId: 't2' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/Users/me/app/a.ts' })
  await $.tool.call({ tool: 'Write', file_path: 'C:/Users/me/app/a.ts', content: 'x' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/Users/me/app/c.ts', agentId: 'sub-1' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).toContain('Read back C:/Users/me/app/a.ts')
  expect(b).toContain('Read back C:/Users/me/app/b.ts')
  expect(b).toContain('Read back C:/Users/me/app/c.ts')
})

test('a shell command naming the file counts as checking it; a row asking to run something needs that, a Read is not enough', async ($, on) => {
  const seen = fresh()
  stubs(on, 'VERIFY: Run the tests in /home/me/app/src/parser.test.ts\nVERIFY: Đọc lại /home/me/app/src/out.log để xác nhận\nVERIFY: Run the tests for /home/me/app/src/lexer.ts\nVERIFY: Run the tests in /home/me/app/src\nVERIFY: Read back C:/Users/me/notes.md', null, seen)
  await start($)
  await $.turn.start({ turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'cd /home/me/app/src && npx vitest run /home/me/app/src/parser.test.ts' })
  await $.tool.call({ tool: 'PowerShell', command: 'Get-Content "/home/me/app/src/out.log" -Tail 20' })
  await $.tool.call({ tool: 'Read', file_path: '/home/me/app/src/lexer.ts' })
  await $.tool.call({ tool: 'Bash', command: 'cat /c/Users/me/notes.md' })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000 })
  const b = await band($)
  expect(b).not.toContain('parser.test.ts')
  expect(b).not.toContain('out.log')
  expect(b).not.toContain('notes.md')
  expect(b).toContain('Run the tests for /home/me/app/src/lexer.ts')
  // A directory named in a command (cd) is not a check of what is in it.
  expect(b).toContain('Run the tests in /home/me/app/src')
})

test('dropAlreadyChecked: path matching ignores case, slashes and msys drives, and stops at a longer name', () => {
  const calls = [{ read: 'c:/users/me/a.ts' }, { run: 'cat c:/users/me/b.ts.bak && node c:/users/me/d.js' }]
  const items = [
    { tag: 'VERIFY', text: 'Read back C:\\Users\\Me\\a.ts' },
    { tag: 'VERIFY', text: 'Read back /c/Users/me/a.ts' },
    { tag: 'VERIFY', text: 'Read back C:/Users/me/b.ts' },
    { tag: 'VERIFY', text: 'Run C:/Users/me/d.js again' },
    { tag: 'VERIFY', text: 'Run the whole suite again' },
    { tag: 'HANDOFF', text: 'Summarise C:/Users/me/a.ts for review' },
  ]
  expect(dropAlreadyChecked(items, calls).map((it) => it.text)).toEqual(['Read back C:/Users/me/b.ts', 'Run the whole suite again', 'Summarise C:/Users/me/a.ts for review'])
  expect(dropAlreadyChecked(items, [])).toEqual(items)
})
