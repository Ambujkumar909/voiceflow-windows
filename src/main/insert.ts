import { clipboard, ClipboardItem } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { log } from './log'

/*
 * Text insertion uses Win32 SendInput from a long-lived Windows PowerShell process
 * (built into Windows, compiled once at startup via Add-Type), so no third-party
 * native module is needed. Commands go over stdin, one per line; replies are
 * "OK ..." or "ERR ...".
 *   PASTE        -> Ctrl+V
 *   TYPE <b64>   -> types UTF-8 text as KEYEVENTF_UNICODE events (newline = Shift+Enter)
 *   CHORD a,b,c  -> presses virtual-key codes together (used by the self-test)
 *   DOWN a,b / UP a,b -> only presses / only releases them (self-test of hold-to-talk; mask key)
 *   FG           -> process name of the foreground window
 *   FOCUS <hwnd> -> bring one of our windows to the front (self-test only; Windows blocks
 *                   SetForegroundWindow from background apps unless input is attached)
 * Both PASTE and TYPE first wait (up to 1.5 s) for the user to release modifier keys,
 * so a held Alt/Shift from the hotkey does not turn Ctrl+V into something else.
 */
const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class FlowKb {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  const uint UP = 2, UNI = 4;
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void WaitForModifiers() {
    int[] mods = { 0x10, 0x11, 0x12, 0x5B, 0x5C };
    for (int t = 0; t < 150; t++) {
      bool down = false;
      foreach (int m in mods) if ((GetAsyncKeyState(m) & 0x8000) != 0) down = true;
      if (!down) return;
      Thread.Sleep(10);
    }
  }
  static string Send(List<INPUT> l) {
    if (l.Count == 0) return "OK";
    var a = l.ToArray();
    uint n = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    return n == a.Length ? "OK" : "ERR input was blocked by the target window (" + n + "/" + a.Length + ", win32 error " + Marshal.GetLastWin32Error() + ")";
  }
  public static string Paste() { WaitForModifiers(); return Send(new List<INPUT> { Key(0x11,0,0), Key(0x56,0,0), Key(0x56,0,UP), Key(0x11,0,UP) }); }
  public static string Type(string s) {
    WaitForModifiers();
    var l = new List<INPUT>();
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { l.Add(Key(0x10,0,0)); l.Add(Key(0x0D,0,0)); l.Add(Key(0x0D,0,UP)); l.Add(Key(0x10,0,UP)); }
      else { l.Add(Key(0,c,UNI)); l.Add(Key(0,c,UNI|UP)); }
    }
    return Send(l);
  }
  public static string Chord(string csv, bool press, bool release) {
    var vks = new List<ushort>();
    foreach (var p in csv.Split(',')) vks.Add(Convert.ToUInt16(p, 16));
    var l = new List<INPUT>();
    if (press) foreach (var v in vks) l.Add(Key(v,0,0));
    if (release) for (int i = vks.Count - 1; i >= 0; i--) l.Add(Key(vks[i],0,UP));
    return Send(l);
  }
  public static string Focus(string hex) {
    IntPtr h = new IntPtr(Convert.ToInt64(hex, 16));
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(me, fg, false);
    return ok ? "OK" : "ERR focus refused";
  }
  public static string Foreground() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    try { return "OK " + Process.GetProcessById((int)pid).ProcessName; } catch { return "OK unknown"; }
  }
}
'@
[Console]::Out.WriteLine('READY')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    if ($line -eq 'PASTE') { $r = [FlowKb]::Paste() }
    elseif ($line.StartsWith('TYPE ')) { $r = [FlowKb]::Type([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(5)))) }
    elseif ($line.StartsWith('CHORD ')) { $r = [FlowKb]::Chord($line.Substring(6), $true, $true) }
    elseif ($line.StartsWith('DOWN ')) { $r = [FlowKb]::Chord($line.Substring(5), $true, $false) }
    elseif ($line.StartsWith('UP ')) { $r = [FlowKb]::Chord($line.Substring(3), $false, $true) }
    elseif ($line -eq 'FG') { $r = [FlowKb]::Foreground() }
    elseif ($line.StartsWith('FOCUS ')) { $r = [FlowKb]::Focus($line.Substring(6)) }
    else { $r = 'ERR unknown command' }
  } catch { $r = 'ERR ' + $_.Exception.Message }
  [Console]::Out.WriteLine($r)
}
`

let proc: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let waiting: ((line: string) => void)[] = []
let queue: Promise<unknown> = Promise.resolve()

function start(): Promise<void> {
  if (ready) return ready
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')
  const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true })
  proc = p
  ready = new Promise((resolve, reject) => {
    const rl = createInterface({ input: p.stdout })
    rl.once('line', (l) => (l === 'READY' ? resolve() : reject(new Error('insert helper: ' + l))))
    rl.on('line', (l) => l !== 'READY' && waiting.shift()?.(l))
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('exit', (code) => {
      log('warn', 'insert helper exited', { code, err: err.slice(0, 500) })
      waiting.forEach((w) => w('ERR helper exited'))
      waiting = []
      proc = null
      ready = null
      reject(new Error('insert helper exited: ' + err.slice(0, 200)))
    })
  })
  ready.catch(() => {})
  return ready
}

/** Serialized request/response over the helper's stdin/stdout. */
function send(cmd: string, timeoutMs = 10_000): Promise<string> {
  const run = async (): Promise<string> => {
    await start()
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('insert helper timed out')), timeoutMs)
      waiting.push((line) => {
        clearTimeout(t)
        line.startsWith('OK') ? resolve(line.slice(3)) : reject(new Error(line.replace(/^ERR /, '')))
      })
      proc!.stdin.write(cmd + '\n')
    })
  }
  const r = queue.then(run, run)
  queue = r.catch(() => {})
  return r
}

export const warmupInserter = (): Promise<void> => start()
export const foregroundApp = (): Promise<string> => send('FG').catch(() => 'unknown')
const hex = (vks: number[]): string => vks.map((v) => v.toString(16)).join(',')
export const pressChord = (vks: number[]): Promise<string> => send('CHORD ' + hex(vks))
export const keysDown = (vks: number[]): Promise<string> => send('DOWN ' + hex(vks))
export const focusWindow = (hwnd: Buffer): Promise<string> => send('FOCUS ' + hwnd.readBigUInt64LE().toString(16))
export const keysUp = (vks: number[]): Promise<string> => send('UP ' + hex(vks))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Copy every format's payload now, before we overwrite the clipboard (items from read() are lazy). */
async function snapshotClipboard(): Promise<ClipboardItem[] | null> {
  try {
    const items = await clipboard.read()
    return await Promise.all(
      items.map(async (it) => new ClipboardItem(Object.fromEntries(await Promise.all(it.types.map(async (t) => [t, await it.getType(t)])))))
    )
  } catch (e) {
    log('warn', 'clipboard snapshot failed; it will not be restored', { error: String(e) })
    return null
  }
}

/**
 * Insert text into whatever window has focus. On failure the transcript is left on
 * the clipboard so the user can paste it manually.
 */
export async function insertText(text: string, mode: 'paste' | 'type', restoreClipboard: boolean): Promise<void> {
  if (mode === 'type') {
    try {
      await send('TYPE ' + Buffer.from(text, 'utf8').toString('base64'), 30_000)
    } catch (e) {
      await clipboard.writeText(text)
      throw new Error(`${(e as Error).message}. Text copied to clipboard.`)
    }
    return
  }
  await pendingRestore // a quick second dictation must not snapshot our own text
  const saved = restoreClipboard ? await snapshotClipboard() : null
  await clipboard.writeText(text)
  try {
    await send('PASTE')
  } catch (e) {
    throw new Error(`${(e as Error).message}. Text copied to clipboard.`)
  }
  // The text is in; restore the user's clipboard in the background so dictation finishes now.
  if (saved) pendingRestore = restoreLater(saved, text)
}

let pendingRestore: Promise<void> = Promise.resolve()
async function restoreLater(saved: ClipboardItem[], text: string): Promise<void> {
  try {
    await sleep(500) // let the target app read the clipboard before restoring
    // Only restore if nothing else replaced the clipboard in the meantime.
    if ((await clipboard.readText()) === text) await (saved.length ? clipboard.write(saved) : Promise.resolve(clipboard.clear()))
  } catch (e) {
    log('warn', 'clipboard restore failed', { error: String(e) })
  }
}

/** Resolves once any background clipboard restore is done. */
export const clipboardSettled = (): Promise<void> => pendingRestore

export function disposeInserter(): void {
  proc?.stdin.end()
  proc?.kill()
  proc = null
}
