'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── API helper ────────────────────────────────────────────────────────────
let _onUnauthorized: (() => void) | null = null;

async function api(path: string, opts: RequestInit = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('session_token') || '' : '';
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': token,
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
  if (res.status === 401) {
    if (_onUnauthorized) _onUnauthorized();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || `HTTP ${res.status}`);
  return data;
}

function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

function timeAgo(ts?: number) {
  if (!ts) return 'never';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// ─── Types ─────────────────────────────────────────────────────────────────
interface Provider {
  id: string;
  name: string;
  type: 'openai' | 'zai';
  priority: number;
  enabled: boolean;
  proxy_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  api_key_masked?: string;
  zai_thinking?: string;
}

interface Bot {
  id: string;
  name: string;
  persona: string;
  status: string;
  discord_user_id?: string;
  guild_id?: string;
  channel_ids: string[];
  delegated_bots: string[];
  providers: Provider[];
  llm: {
    proxy_url: string;
    model: string;
    temperature: number;
    max_tokens: number;
    api_key_masked?: string;
  };
  gating: {
    response_probability: number;
    skip_patterns: string[];
    ignore_bots: boolean;
    max_context_messages: number;
    cooldown_ms: number;
    response_delay_ms: number;
  };
  tools: {
    web_search: boolean;
    ping_proxy: boolean;
    fetch_url: boolean;
    github_lookup: boolean;
    memory: boolean;
    schedule_reminder: boolean;
    react_to_message: boolean;
    summon_bot: boolean;
  };
  created_at?: number;
  updated_at?: number;
}

interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  text_channels: Array<{ id: string; name: string; topic?: string | null }>;
}

// ─── Default bot factory ────────────────────────────────────────────────────
function emptyProvider(id: string): Provider {
  return {
    id,
    name: 'Provider',
    type: 'openai',
    priority: 1,
    enabled: true,
    proxy_url: 'https://lolmaobruhhh-fap.hf.space/v1',
    model: 'idk:gemini-3.6-flash-high-search',
    temperature: 0.85,
    max_tokens: 1500,
  };
}

function emptyBot(): Bot {
  return {
    id: '',
    name: '',
    persona: '',
    status: 'stopped',
    guild_id: '',
    channel_ids: [],
    delegated_bots: [],
    providers: [emptyProvider('p1')],
    llm: {
      proxy_url: 'https://lolmaobruhhh-fap.hf.space/v1',
      model: 'idk:gemini-3.6-flash-high-search',
      temperature: 0.85,
      max_tokens: 1500,
    },
    gating: {
      response_probability: 1,
      skip_patterns: ['^\\+$', '^-$', '^(k|kk)$'],
      ignore_bots: false,
      max_context_messages: 30,
      cooldown_ms: 2000,
      response_delay_ms: 0,
    },
    tools: {
      web_search: true,
      ping_proxy: true,
      fetch_url: true,
      github_lookup: true,
      memory: true,
      schedule_reminder: true,
      react_to_message: true,
      summon_bot: false,
    },
  };
}

// ─── Main app ───────────────────────────────────────────────────────────────
export default function Home() {
  const [authed, setAuthed] = useState(false);
  const [pw, setPw] = useState('');
  const [loginErr, setLoginErr] = useState('');
  const [tab, setTab] = useState<'bots' | 'proxies' | 'logs'>('bots');
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const [editor, setEditor] = useState<{ bot: Bot; isNew: boolean } | null>(null);

  _onUnauthorized = () => {
    setAuthed(false);
    localStorage.removeItem('session_token');
  };

  // Toast helper
  const flash = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  }, []);

  // Login
  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginErr('');
    try {
      const r = (await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password: pw }),
      })) as { token: string };
      localStorage.setItem('session_token', r.token);
      setAuthed(true);
      setPw('');
    } catch (e: any) {
      setLoginErr(e.message || 'Login failed');
    }
  }

  function signOut() {
    api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('session_token');
    setAuthed(false);
  }

  // Load bots list
  const loadBots = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await api('/api/bots')) as { bots: Bot[] };
      setBots(r.bots || []);
    } catch {
      /* unauthorized handled globally */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed) loadBots();
  }, [authed, loadBots]);

  // ─── Login screen ──────────────────────────────────────────────────────────
  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-4">
        <div className="w-full max-w-sm space-y-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Discord Bot Fleet</h1>
            <p className="text-sm text-muted-foreground mt-1">Sign in with admin password</p>
          </div>
          <form onSubmit={doLogin} className="space-y-3">
            <input
              type="password"
              placeholder="Admin password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
            {loginErr && <div className="text-sm text-destructive">{esc(loginErr)}</div>}
            <button
              type="submit"
              className="w-full px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90"
            >
              Sign in
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ─── Main panel ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="font-bold text-lg">Discord Bot Fleet</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {bots.length} bot{bots.length === 1 ? '' : 's'}
            </span>
          </div>
          <nav className="flex items-center gap-1">
            {(['bots', 'proxies', 'logs'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  'px-3 py-1.5 rounded-md text-sm font-medium capitalize transition ' +
                  (tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')
                }
              >
                {t}
              </button>
            ))}
            <button
              onClick={signOut}
              className="ml-2 px-3 py-1.5 rounded-md text-sm font-medium border border-border hover:bg-muted"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {tab === 'bots' && (
          <BotsTab
            bots={bots}
            loading={loading}
            onRefresh={loadBots}
            onEdit={(b) => setEditor({ bot: JSON.parse(JSON.stringify(b)), isNew: false })}
            onCreate={() => setEditor({ bot: emptyBot(), isNew: true })}
            onAction={async (b, action) => {
              try {
                await api(`/api/bots/${b.id}/${action}`, { method: 'POST' });
                flash(`${action} OK for ${b.name}`, 'ok');
                await loadBots();
              } catch (e: any) {
                flash(`${action} failed: ${e.message}`, 'err');
              }
            }}
            onClearContext={async (b) => {
              try {
                await api(`/api/bots/${b.id}/clear-context`, { method: 'POST' });
                flash(`Context cleared for ${b.name}`, 'ok');
              } catch (e: any) {
                flash(`Clear failed: ${e.message}`, 'err');
              }
            }}
            onClearAll={async () => {
              if (!confirm('Clear ALL bot contexts? This wipes all conversation history for every bot.')) return;
              try {
                await api('/api/bots/clear-all-context', { method: 'POST' });
                flash('All contexts cleared', 'ok');
              } catch (e: any) {
                flash(`Clear all failed: ${e.message}`, 'err');
              }
            }}
            onStopAll={async () => {
              if (!confirm('STOP ALL bots immediately? Use this if bots keep replying after stopping.')) return;
              try {
                await api('/api/bots/stop-all', { method: 'POST' });
                flash('Stop-all signal sent', 'ok');
                await loadBots();
              } catch (e: any) {
                flash(`Stop all failed: ${e.message}`, 'err');
              }
            }}
            onDelete={async (b) => {
              if (!confirm(`Delete bot "${b.name}"?`)) return;
              try {
                await api(`/api/bots/${b.id}`, { method: 'DELETE' });
                flash(`Deleted ${b.name}`, 'ok');
                await loadBots();
              } catch (e: any) {
                flash(`Delete failed: ${e.message}`, 'err');
              }
            }}
          />
        )}
        {tab === 'proxies' && <ProxiesTab />}
        {tab === 'logs' && <LogsTab bots={bots} />}
      </main>

      {editor && (
        <BotEditor
          bot={editor.bot}
          isNew={editor.isNew}
          allBots={bots}
          onClose={() => setEditor(null)}
          flash={flash}
          onDone={async () => {
            setEditor(null);
            await loadBots();
          }}
        />
      )}

      {toast && (
        <div
          className={
            'fixed bottom-4 right-4 z-[60] px-4 py-2 rounded-md shadow-lg text-sm ' +
            (toast.kind === 'ok' ? 'bg-primary text-primary-foreground' : 'bg-destructive text-white')
          }
        >
          {esc(toast.msg)}
        </div>
      )}
    </div>
  );
}

// ─── Bots tab ──────────────────────────────────────────────────────────────
function BotsTab({
  bots,
  loading,
  onRefresh,
  onEdit,
  onCreate,
  onAction,
  onClearContext,
  onClearAll,
  onStopAll,
  onDelete,
}: {
  bots: Bot[];
  loading: boolean;
  onRefresh: () => void;
  onEdit: (b: Bot) => void;
  onCreate: () => void;
  onAction: (b: Bot, action: 'start' | 'stop' | 'restart') => void;
  onClearContext: (b: Bot) => void;
  onClearAll: () => void;
  onStopAll: () => void;
  onDelete: (b: Bot) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Your bots</h2>
          <button onClick={onClearAll} className="text-xs bg-yellow-500/20 text-yellow-500 border border-yellow-500/30 px-2 py-1 rounded hover:bg-yellow-500/30">Clear All Context</button>
          <button onClick={onStopAll} className="text-xs bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-1 rounded hover:bg-red-500/30">Stop All Bots</button>
        </div>
        <h2 className="text-xl font-semibold">Bots</h2>
        <div className="flex gap-2">
          <button
            onClick={onRefresh}
            className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
          >
            Refresh
          </button>
          <button
            onClick={onCreate}
            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium"
          >
            + New bot
          </button>
        </div>
      </div>

      {loading && bots.length === 0 ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : bots.length === 0 ? (
        <div className="text-muted-foreground text-sm">No bots yet. Click "New bot" to create one.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((b) => (
            <div key={b.id} className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{esc(b.name)}</div>
                  <div className="text-xs text-muted-foreground font-mono">{esc(b.id)}</div>
                </div>
                <span
                  className={
                    'shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs ' +
                    (b.status === 'running'
                      ? 'bg-green-500/15 text-green-400'
                      : b.status === 'error'
                      ? 'bg-red-500/15 text-red-400'
                      : 'bg-muted text-muted-foreground')
                  }
                >
                  <span
                    className={
                      'w-1.5 h-1.5 rounded-full ' +
                      (b.status === 'running' ? 'bg-green-400' : b.status === 'error' ? 'bg-red-400' : 'bg-muted-foreground')
                    }
                  />
                  {esc(b.status)}
                </span>
              </div>

              <div className="text-xs space-y-1 text-muted-foreground">
                <div>
                  <span className="text-foreground/70">Providers:</span>{' '}
                  {b.providers.length === 0 ? (
                    <span className="italic">none</span>
                  ) : (
                    b.providers.map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && ', '}
                        <span className={p.enabled ? '' : 'line-through opacity-60'}>{esc(p.name)}</span>
                        {p.type === 'zai' && <span className="opacity-60"> (zai)</span>}
                      </span>
                    ))
                  )}
                </div>
                <div>
                  <span className="text-foreground/70">Channels:</span>{' '}
                  {b.channel_ids.length === 0 ? (
                    <span className="italic">all</span>
                  ) : (
                    <span>{b.channel_ids.length} channel{b.channel_ids.length === 1 ? '' : 's'}</span>
                  )}
                </div>
                <div>
                  <span className="text-foreground/70">Updated:</span> {timeAgo(b.updated_at)}
                </div>
              </div>

              <div className="mt-auto pt-2 flex flex-wrap gap-1.5">
                {b.status === 'running' ? (
                  <button
                    onClick={() => onAction(b, 'stop')}
                    className="px-2.5 py-1 rounded-md bg-muted text-sm hover:bg-muted/70"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    onClick={() => onAction(b, 'start')}
                    className="px-2.5 py-1 rounded-md bg-green-600 text-white text-sm hover:opacity-90"
                  >
                    Start
                  </button>
                )}
                <button
                  onClick={() => onAction(b, 'restart')}
                  className="px-2.5 py-1 rounded-md bg-muted text-sm hover:bg-muted/70"
                >
                  Restart
                </button>
                <button
                  onClick={() => onEdit(b)}
                  className="px-2.5 py-1 rounded-md bg-muted text-sm hover:bg-muted/70"
                >
                  Edit
                </button>
                <button
                  onClick={() => onClearContext(b)}
                  className="px-2.5 py-1 rounded-md bg-yellow-500/20 text-yellow-500 text-sm hover:bg-yellow-500/30"
                  title="Clear conversation history for this bot"
                >
                  Clear
                </button>
                <button
                  onClick={() => onDelete(b)}
                  className="px-2.5 py-1 rounded-md bg-destructive text-white text-sm hover:opacity-90"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Bot editor modal ──────────────────────────────────────────────────────
function BotEditor({
  bot: initialBot,
  isNew,
  allBots,
  onClose,
  flash,
  onDone,
}: {
  bot: Bot;
  isNew: boolean;
  allBots: Bot[];
  onClose: () => void;
  flash: (msg: string, kind?: 'ok' | 'err') => void;
  onDone: () => void | Promise<void>;
}) {
  const [bot, setBot] = useState<Bot>(initialBot);
  const [tokenInput, setTokenInput] = useState(''); // for new bots OR token rotation
  const [pendingKeys, setPendingKeys] = useState<Record<string, string>>({}); // providerId -> new key
  const [guilds, setGuilds] = useState<GuildInfo[] | null>(null);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [chanErr, setChanErr] = useState('');
  const [saving, setSaving] = useState(false);

  // Patch helper
  function patch<K extends keyof Bot>(key: K, val: Bot[K]) {
    setBot((b) => ({ ...b, [key]: val }));
  }

  // Load channels — uses bot.id (existing bot) OR posts to /api/discord/guilds with the token input.
  async function loadChannels() {
    setChanErr('');
    setLoadingChannels(true);
    try {
      let r: { guilds: GuildInfo[] };
      if (!isNew && bot.id) {
        r = (await api(`/api/bots/${bot.id}/channels`)) as { guilds: GuildInfo[] };
      } else {
        if (!tokenInput) {
          setChanErr('Enter a token first to load channels');
          return;
        }
        r = (await api('/api/discord/guilds', {
          method: 'POST',
          body: JSON.stringify({ token: tokenInput }),
        })) as { guilds: GuildInfo[] };
      }
      setGuilds(r.guilds || []);
      // If we got the guilds, auto-fill guild_id if missing
      if ((!bot.guild_id || bot.guild_id === '') && r.guilds.length > 0) {
        patch('guild_id', r.guilds[0].id);
      }
    } catch (e: any) {
      setChanErr(e.message || 'Failed to load channels');
    } finally {
      setLoadingChannels(false);
    }
  }

  // Provider editor helpers
  function addProvider() {
    const newP = emptyProvider('p' + (bot.providers.length + 1) + '_' + Date.now().toString(36).slice(-4));
    setBot((b) => ({ ...b, providers: [...b.providers, newP] }));
  }
  function rmProvider(id: string) {
    setBot((b) => ({ ...b, providers: b.providers.filter((p) => p.id !== id) }));
  }
  function patchProvider(id: string, k: keyof Provider, v: any) {
    setBot((b) => ({
      ...b,
      providers: b.providers.map((p) => (p.id === id ? { ...p, [k]: v } : p)),
    }));
  }

  // Save handler — lives inside the editor so it has access to local state.
  async function doSave(withRestart: boolean) {
    if (!bot.name || !bot.persona) {
      flash('Name and persona are required', 'err');
      return;
    }
    if (isNew && !tokenInput) {
      flash('Token is required for new bots', 'err');
      return;
    }
    setSaving(true);
    const payload: any = {
      name: bot.name,
      persona: bot.persona,
      guild_id: bot.guild_id || '',
      channel_ids: bot.channel_ids,
      delegated_bots: bot.delegated_bots,
      providers: bot.providers.map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        priority: p.priority,
        enabled: p.enabled,
        proxy_url: p.proxy_url,
        model: p.model,
        temperature: p.temperature,
        max_tokens: p.max_tokens,
        zai_thinking: p.type === 'zai' ? p.zai_thinking : undefined,
        // Send the new key if one was typed; otherwise omit (undefined) so the
        // backend keeps the existing encrypted value.
        api_key: pendingKeys[p.id] || undefined,
      })),
      gating: bot.gating,
      tools: bot.tools,
    };
    if (tokenInput) payload.token = tokenInput;
    try {
      if (isNew) {
        const r = (await api('/api/bots', {
          method: 'POST',
          body: JSON.stringify(payload),
        })) as { bot: Bot };
        flash(`Created ${r.bot.name}`, 'ok');
      } else {
        // Backend auto-restarts the bot if it's currently running (so the
        // in-memory config — captured at startBot time — gets refreshed).
        // The response includes _restart: 'ok' | 'failed' | undefined.
        const r = (await api(`/api/bots/${bot.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        })) as { _restart?: 'ok' | 'failed'; _restart_error?: string };

        if (r._restart === 'ok') {
          flash(`Saved ${bot.name} — bot was running, auto-restarted to apply changes`, 'ok');
        } else if (r._restart === 'failed') {
          flash(`Saved ${bot.name} — but auto-restart FAILED: ${r._restart_error || 'unknown error'}. Click Restart on the bot card.`, 'err');
        } else {
          // Bot wasn't running — just saved the config for next start.
          flash(`Saved ${bot.name} (bot is stopped — config will apply on next start)`, 'ok');
        }

        // If the user explicitly clicked "Save & Restart" and the backend
        // already restarted (because the bot was running), don't double-restart.
        // Only restart if the bot was stopped and the user wanted a restart.
        if (withRestart && !r._restart) {
          await api(`/api/bots/${bot.id}/restart`, { method: 'POST' });
          flash(`Started ${bot.name}`, 'ok');
        }
      }
      await onDone();
    } catch (e: any) {
      flash(`Save failed: ${e.message}`, 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-w-3xl mx-auto my-4 bg-card border border-border rounded-2xl shadow-xl">
        {/* Sticky header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 border-b border-border bg-card rounded-t-2xl">
          <h2 className="font-semibold text-lg">{isNew ? 'Create bot' : `Edit ${bot.name}`}</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-muted" aria-label="Close">
            ✕
          </button>
        </div>

        {/* Scrollable body */}
        <div className="px-6 py-4 space-y-6">
          {/* Name */}
          <Section title="Name">
            <input
              type="text"
              value={bot.name}
              onChange={(e) => patch('name', e.target.value)}
              placeholder="Bot name"
              className="w-full px-3 py-2 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </Section>

          {/* Persona */}
          <Section title="Persona">
            <textarea
              value={bot.persona}
              onChange={(e) => patch('persona', e.target.value)}
              rows={8}
              placeholder="Persona / system prompt…"
              className="w-full px-3 py-2 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
            />
          </Section>

          {/* Token */}
          <Section title={isNew ? 'Discord bot token' : 'Rotate token (leave blank to keep)'}>
            <div className="flex gap-2">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={isNew ? 'Bot token from Discord Developer Portal' : '•••• (unchanged)'}
                className="flex-1 px-3 py-2 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
              />
              <button
                onClick={loadChannels}
                disabled={loadingChannels}
                className="px-3 py-2 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
              >
                {loadingChannels ? 'Loading…' : 'Load channels'}
              </button>
            </div>
            {chanErr && <div className="text-xs text-destructive mt-1">{esc(chanErr)}</div>}
          </Section>

          {/* Guild ID */}
          <Section title="Guild ID">
            <input
              type="text"
              value={bot.guild_id || ''}
              onChange={(e) => patch('guild_id', e.target.value)}
              placeholder="Guild ID (blank = all guilds the bot is in)"
              className="w-full px-3 py-2 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
            />
          </Section>

          {/* Channels */}
          <Section title={`Channels (${bot.channel_ids.length} selected)`}>
            {guilds === null ? (
              <div className="text-sm text-muted-foreground">
                Click "Load channels" above to fetch the bot's guilds + channels.
              </div>
            ) : guilds.length === 0 ? (
              <div className="text-sm text-muted-foreground">Bot is not in any guilds.</div>
            ) : (
              <div className="space-y-3 max-h-72 overflow-y-auto custom-scroll pr-1">
                {guilds.map((g) => (
                  <div key={g.id} className="border border-border rounded-md p-2">
                    <div className="font-medium text-sm mb-1.5 flex items-center gap-2">
                      {g.icon && <img src={g.icon} alt="" className="w-4 h-4 rounded" />}
                      {esc(g.name)}
                      <span className="text-xs text-muted-foreground font-mono">{esc(g.id)}</span>
                    </div>
                    <div className="space-y-1 pl-2">
                      {g.text_channels.length === 0 ? (
                        <div className="text-xs text-muted-foreground italic">No text channels found</div>
                      ) : (
                        g.text_channels.map((c) => {
                          const checked = bot.channel_ids.includes(c.id);
                          return (
                            <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-muted/50 px-1.5 py-0.5 rounded">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...bot.channel_ids, c.id]
                                    : bot.channel_ids.filter((x) => x !== c.id);
                                  patch('channel_ids', next);
                                }}
                              />
                              <span className="font-mono text-xs opacity-70">#</span>
                              <span>{esc(c.name)}</span>
                              <span className="text-xs text-muted-foreground font-mono ml-auto">{esc(c.id)}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-muted-foreground mt-1">
              If 0 channels are selected, the bot responds in ALL text channels of the configured guild.
            </div>
          </Section>

          {/* Providers */}
          <Section
            title="Providers (raced in parallel — first success wins)"
            right={
              <button onClick={addProvider} className="px-2 py-1 rounded-md border border-border text-xs hover:bg-muted">
                + Add
              </button>
            }
          >
            <div className="space-y-3">
              {bot.providers.length === 0 && (
                <div className="text-sm text-muted-foreground italic">No providers. Click "+ Add" to create one.</div>
              )}
              {bot.providers.map((p, idx) => (
                <div key={p.id} className="border border-border rounded-md p-3 bg-background/50">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-medium text-sm">Provider #{idx + 1}</div>
                    <button
                      onClick={() => rmProvider(p.id)}
                      className="text-xs text-destructive hover:underline"
                    >
                      remove
                    </button>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-2 text-sm">
                    <LabeledInput label="Name" value={p.name} onChange={(v) => patchProvider(p.id, 'name', v)} />
                    <div>
                      <label className="text-xs text-muted-foreground">Type</label>
                      <select
                        value={p.type}
                        onChange={(e) => patchProvider(p.id, 'type', e.target.value as 'openai' | 'zai')}
                        className="w-full px-2 py-1.5 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        <option value="openai">openai (OpenAI-compatible proxy)</option>
                        <option value="zai">zai (z.ai SDK direct)</option>
                      </select>
                    </div>
                    {p.type === 'openai' && (
                      <LabeledInput
                        label="Proxy URL"
                        value={p.proxy_url || ''}
                        onChange={(v) => patchProvider(p.id, 'proxy_url', v)}
                        mono
                      />
                    )}
                    <LabeledInput
                      label="Model"
                      value={p.model || ''}
                      onChange={(v) => patchProvider(p.id, 'model', v)}
                      mono
                    />
                    {p.type === 'openai' && (
                      <div>
                        <label className="text-xs text-muted-foreground">
                          API key {p.api_key_masked === 'set' ? '(set — leave blank to keep)' : '(not set)'}
                        </label>
                        <input
                          type="password"
                          value={pendingKeys[p.id] || ''}
                          onChange={(e) =>
                            setPendingKeys((m) => ({ ...m, [p.id]: e.target.value }))
                          }
                          placeholder={p.api_key_masked === 'set' ? '•••• set (blank = keep)' : 'Paste key'}
                          className="w-full px-2 py-1.5 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-xs"
                        />
                      </div>
                    )}
                    {p.type === 'openai' && (
                      <LabeledInput
                        label="Temperature"
                        type="number"
                        value={String(p.temperature ?? 0.85)}
                        onChange={(v) => patchProvider(p.id, 'temperature', parseFloat(v) || 0)}
                      />
                    )}
                    {p.type === 'openai' && (
                      <LabeledInput
                        label="Max tokens"
                        type="number"
                        value={String(p.max_tokens ?? 1500)}
                        onChange={(v) => patchProvider(p.id, 'max_tokens', parseInt(v, 10) || 0)}
                      />
                    )}
                    <LabeledInput
                      label="Priority (lower = tried first)"
                      type="number"
                      value={String(p.priority ?? 1)}
                      onChange={(v) => patchProvider(p.id, 'priority', parseInt(v, 10) || 1)}
                    />
                    {p.type === 'zai' && (
                      <div>
                        <label className="text-xs text-muted-foreground">z.ai thinking</label>
                        <select
                          value={p.zai_thinking || 'disabled'}
                          onChange={(e) => patchProvider(p.id, 'zai_thinking', e.target.value)}
                          className="w-full px-2 py-1.5 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="disabled">disabled</option>
                          <option value="enabled">enabled</option>
                        </select>
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!p.enabled}
                          onChange={(e) => patchProvider(p.id, 'enabled', e.target.checked)}
                        />
                        Enabled
                      </label>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Behavior */}
          <Section title="Behavior / gating">
            <div className="space-y-3 text-sm">
              <div>
                <label className="flex items-center justify-between">
                  <span>Response probability: <b>{(bot.gating.response_probability * 100).toFixed(0)}%</b></span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={bot.gating.response_probability}
                  onChange={(e) =>
                    setBot((b) => ({
                      ...b,
                      gating: { ...b.gating, response_probability: parseFloat(e.target.value) },
                    }))
                  }
                  className="w-full"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Skip patterns (one regex per line)</label>
                <textarea
                  value={bot.gating.skip_patterns.join('\n')}
                  onChange={(e) =>
                    setBot((b) => ({
                      ...b,
                      gating: { ...b.gating, skip_patterns: e.target.value.split('\n').filter((s) => s !== '') },
                    }))
                  }
                  rows={3}
                  className="w-full px-2 py-1.5 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-xs"
                />
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                <LabeledInput
                  label="Cooldown (ms)"
                  type="number"
                  value={String(bot.gating.cooldown_ms)}
                  onChange={(v) =>
                    setBot((b) => ({ ...b, gating: { ...b.gating, cooldown_ms: parseInt(v, 10) || 0 } }))
                  }
                />
                <LabeledInput
                  label="Max context msgs"
                  type="number"
                  value={String(bot.gating.max_context_messages)}
                  onChange={(v) =>
                    setBot((b) => ({ ...b, gating: { ...b.gating, max_context_messages: parseInt(v, 10) || 0 } }))
                  }
                />
                <LabeledInput
                  label="Response delay (ms)"
                  type="number"
                  value={String(bot.gating.response_delay_ms)}
                  onChange={(v) =>
                    setBot((b) => ({ ...b, gating: { ...b.gating, response_delay_ms: parseInt(v, 10) || 0 } }))
                  }
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!bot.gating.ignore_bots}
                  onChange={(e) =>
                    setBot((b) => ({ ...b, gating: { ...b.gating, ignore_bots: e.target.checked } }))
                  }
                />
                Ignore bot messages (won't respond to other bots — bot-to-bot summon flow always bypasses this)
              </label>
            </div>
          </Section>

          {/* Tools */}
          <Section title="Tools">
            <div className="grid grid-cols-2 gap-2 text-sm">
              {([
                ['web_search', 'Web search'],
                ['ping_proxy', 'Ping AI proxy'],
                ['fetch_url', 'Fetch URL'],
                ['github_lookup', 'GitHub lookup'],
                ['memory', 'Memory (read/write)'],
                ['schedule_reminder', 'Schedule reminder'],
                ['react_to_message', 'React to message (multi-emoji)'],
                ['summon_bot', 'Summon bot'],
              ] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!bot.tools[k]}
                    onChange={(e) =>
                      setBot((b) => ({ ...b, tools: { ...b.tools, [k]: e.target.checked } }))
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </Section>

          {/* Delegated bots */}
          <Section title="Delegated bots (allowed targets for summon_bot tool)">
            <div className="space-y-1">
              {allBots.filter((b) => b.id !== bot.id).length === 0 ? (
                <div className="text-sm text-muted-foreground italic">No other bots exist yet.</div>
              ) : (
                allBots
                  .filter((b) => b.id !== bot.id)
                  .map((b) => {
                    const checked = bot.delegated_bots.includes(b.id);
                    return (
                      <label key={b.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...bot.delegated_bots, b.id]
                              : bot.delegated_bots.filter((x) => x !== b.id);
                            patch('delegated_bots', next);
                          }}
                        />
                        {esc(b.name)} <span className="text-xs text-muted-foreground font-mono">{esc(b.id)}</span>
                      </label>
                    );
                  })
              )}
            </div>
          </Section>
        </div>

        {/* Sticky footer */}
        <div className="sticky bottom-0 z-10 flex items-center justify-end gap-2 px-6 py-3 border-t border-border bg-card rounded-b-2xl">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          {!isNew && (
            <button
              onClick={() => doSave(true)}
              disabled={saving}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              title="Save config and (re)start the bot so changes take effect immediately"
            >
              {saving ? 'Saving…' : 'Save & Apply'}
            </button>
          )}
          <button
            onClick={() => doSave(false)}
            disabled={saving}
            className="px-4 py-2 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
            title="Save config only. If the bot is running, it will be auto-restarted to apply changes. If stopped, config applies on next start."
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Small subcomponents ────────────────────────────────────────────────────
function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={
          'w-full px-2 py-1.5 rounded-md bg-background border border-border focus:outline-none focus:ring-2 focus:ring-ring ' +
          (mono ? 'font-mono text-xs' : 'text-sm')
        }
      />
    </div>
  );
}

// ─── Proxies tab ────────────────────────────────────────────────────────────
function ProxiesTab() {
  const [proxyUrl, setProxyUrl] = useState('https://lolmaobruhhh-fap.hf.space/v1');
  const [apiKey, setApiKey] = useState('FAP!');
  const [model, setModel] = useState('');
  const [result, setResult] = useState<any>(null);
  const [pinging, setPinging] = useState(false);

  async function ping() {
    setPinging(true);
    setResult(null);
    try {
      const r = await api('/api/llm/ping', {
        method: 'POST',
        body: JSON.stringify({
          proxy_url: proxyUrl,
          api_key: apiKey,
          model: model || undefined,
        }),
      });
      setResult(r);
    } catch (e: any) {
      setResult({ status: 'error', error: e.message });
    } finally {
      setPinging(false);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Proxies</h2>
      <div className="max-w-md space-y-3">
        <div>
          <label className="text-xs text-muted-foreground">Proxy URL</label>
          <input
            type="text"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">API key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Model (optional — sends test message if set)</label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. gpt-4o-mini"
            className="w-full px-3 py-2 rounded-md bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm"
          />
        </div>
        <button
          onClick={ping}
          disabled={pinging}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {pinging ? 'Pinging…' : 'Ping'}
        </button>
      </div>

      {result && (
        <div className="mt-6 max-w-2xl">
          <h3 className="font-medium mb-2">Result</h3>
          <pre className="text-xs bg-card border border-border rounded-md p-3 overflow-x-auto custom-scroll">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── Logs tab ──────────────────────────────────────────────────────────────
function LogsTab({ bots }: { bots: Bot[] }) {
  const [selected, setSelected] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async () => {
    if (!selected) return;
    try {
      const r = (await api(`/api/bots/${selected}/logs?lines=500`)) as { logs: string[] };
      setLogs(r.logs || []);
      setError('');
    } catch (e: any) {
      setError(e.message);
      setLogs([]);
    }
  }, [selected]);

  useEffect(() => {
    if (selected) {
      // fetchLogs is async; we don't await here — fire and forget.
      // It calls setLogs/setError internally, which the linter flags as
      // "set-state-in-effect", but we genuinely want to refresh logs when
      // the selected bot changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchLogs();
    }
  }, [selected, fetchLogs]);

  useEffect(() => {
    if (timer.current) clearInterval(timer.current);
    if (autoRefresh && selected) {
      timer.current = setInterval(fetchLogs, 3000);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [autoRefresh, selected, fetchLogs]);

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">Logs</h2>
      <div className="flex items-center gap-3 mb-4">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="px-3 py-1.5 rounded-md bg-card border border-border focus:outline-none focus:ring-2 focus:ring-ring text-sm"
        >
          <option value="">— Select bot —</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.id})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh (3s)
        </label>
        <button
          onClick={fetchLogs}
          className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {error && <div className="text-sm text-destructive mb-2">{esc(error)}</div>}

      {!selected ? (
        <div className="text-sm text-muted-foreground">Select a bot above.</div>
      ) : (
        <div className="bg-card border border-border rounded-md p-3 max-h-[60vh] overflow-y-auto custom-scroll">
          {logs.length === 0 ? (
            <div className="text-sm text-muted-foreground italic">No logs yet.</div>
          ) : (
            logs.map((line, i) => {
              let parsed: any = null;
              try {
                parsed = JSON.parse(line);
              } catch {
                /* not JSON */
              }
              if (parsed) {
                const color =
                  parsed.level === 'error'
                    ? 'text-red-400'
                    : parsed.level === 'warn'
                    ? 'text-yellow-400'
                    : parsed.level === 'info'
                    ? 'text-foreground'
                    : 'text-muted-foreground';
                return (
                  <div key={i} className="text-xs font-mono leading-relaxed">
                    <span className="text-muted-foreground">{esc(parsed.ts)}</span>{' '}
                    <span className={color}>[{esc(parsed.level)}]</span>{' '}
                    <span className="text-foreground">{esc(parsed.msg)}</span>
                    {parsed.error && <span className="text-red-400"> — {esc(parsed.error)}</span>}
                    {parsed.provider && <span className="text-muted-foreground"> (via {esc(parsed.provider)})</span>}
                  </div>
                );
              }
              return (
                <div key={i} className="text-xs font-mono text-muted-foreground leading-relaxed">
                  {esc(line)}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
