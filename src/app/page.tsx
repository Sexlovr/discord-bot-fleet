'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

let _onUnauthorized: (() => void) | null = null;

async function api(path: string, opts: RequestInit = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('session_token') || '' : '';
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-session-token': token, ...(opts.headers as Record<string, string> || {}) },
  });
  if (res.status === 401) { if (_onUnauthorized) _onUnauthorized(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any).error || `HTTP ${res.status}`);
  return data;
}

function timeAgo(ts: number | string) {
  if (!ts) return 'never';
  const d = new Date(ts);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return d.toLocaleDateString();
}

function esc(s: any) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ─── Types ───────────────────────────────────────────────────────────────
interface Provider {
  id: string; name: string; type: 'openai' | 'zai'; priority: number; enabled: boolean;
  proxy_url?: string; model?: string; temperature?: number; max_tokens?: number;
  api_key_masked?: string; zai_thinking?: string;
}

interface Bot {
  id: string; name: string; persona: string; status: string; discord_user_id?: string;
  channel_ids: string[]; delegated_bots: string[];
  providers: Provider[];
  llm: { proxy_url: string; model: string; temperature: number; max_tokens: number; api_key_masked?: string };
  gating: { response_probability: number; skip_patterns: string[]; ignore_bots: boolean; max_context_messages: number; cooldown_ms: number; response_delay_ms?: number };
  tools: Record<string, boolean>;
  token_masked?: string;
  updated_at: number;
}

const DEFAULT_TOOLS: Record<string, boolean> = {
  web_search: true, ping_proxy: true, fetch_url: true, github_lookup: true,
  memory: true, schedule_reminder: true, react_to_message: true, summon_bot: false,
};

const TOOL_DESCS: Record<string, string> = {
  web_search: 'Search the web', ping_proxy: 'Test LLM proxies', fetch_url: 'Fetch URLs (SSRF-safe)',
  github_lookup: 'GitHub repo lookup', memory: 'Remember things', schedule_reminder: 'Schedule reminders',
  react_to_message: 'Add emoji reactions', summon_bot: 'Summon other bots',
};

// ─── Login ────────────────────────────────────────────────────────────────
function Login({ onLogin }: { onLogin: () => void }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(''); const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setLoading(true);
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'login failed');
      localStorage.setItem('session_token', data.token);
      onLogin();
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md bg-card border border-border rounded-2xl p-8 shadow-xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center text-2xl">🤖</div>
          <div><h1 className="text-xl font-bold">Bot Fleet</h1><p className="text-xs text-muted-foreground">Multi-bot Discord control panel</p></div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <input type="password" value={pw} onChange={e => setPw(e.target.value)} required autoFocus placeholder="Admin password"
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" />
          <button type="submit" disabled={loading} className="w-full bg-primary text-primary-foreground rounded-lg py-2 text-sm font-medium disabled:opacity-50">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          {err && <div className="text-xs text-red-500">{err}</div>}
        </form>
      </div>
    </div>
  );
}

// ─── Bot Card ──────────────────────────────────────────────────────────────
function BotCard({ bot, onEdit, onStart, onStop, onRestart, onDelete }: any) {
  const activeP = bot.providers?.filter((p: Provider) => p.enabled).length || 0;
  const emoji = bot.name?.toLowerCase().includes('yuki') ? '🌸' : bot.name?.toLowerCase().includes('hana') ? '📚' : bot.name?.toLowerCase().includes('scylla') ? '🐙' : '🤖';
  return (
    <div className="bg-card border border-border rounded-2xl p-5 hover:border-primary/50 transition">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/30 to-primary/5 flex items-center justify-center text-lg">{emoji}</div>
          <div><div className="font-semibold text-sm">{esc(bot.name)}</div><div className="text-xs text-muted-foreground font-mono">{bot.id}</div></div>
        </div>
        <span className="flex items-center gap-2 text-xs">
          <span className={`inline-block w-2 h-2 rounded-full ${bot.status === 'running' ? 'bg-green-500 animate-pulse' : bot.status === 'error' ? 'bg-red-500' : 'bg-gray-500'}`}></span>
          {bot.status}
        </span>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground mb-3">
        <div>Providers: <span className="text-foreground">{activeP} active</span></div>
        <div>Channels: <span className="text-foreground">{bot.channel_ids?.length || 0}</span></div>
        {bot.providers?.map((p: Provider) => <div key={p.id} className="text-[10px] text-muted-foreground/60">· {p.name}: {p.model || '?'}</div>)}
        <div>Updated: {timeAgo(bot.updated_at)}</div>
      </div>
      <div className="flex gap-1 pt-3 border-t border-border">
        {bot.status === 'running' ? (
          <><button onClick={onStop} className="flex-1 text-xs bg-muted hover:bg-yellow-500/20 hover:text-yellow-600 border border-border rounded-lg py-1.5">Stop</button>
            <button onClick={onRestart} className="flex-1 text-xs bg-muted hover:bg-blue-500/20 hover:text-blue-400 border border-border rounded-lg py-1.5">↻</button></>
        ) : (
          <button onClick={onStart} className="flex-1 text-xs bg-muted hover:bg-green-500/20 hover:text-green-600 border border-border rounded-lg py-1.5">Start</button>
        )}
        <button onClick={onEdit} className="flex-1 text-xs bg-muted hover:bg-primary/20 hover:text-primary border border-border rounded-lg py-1.5">Edit</button>
        <button onClick={onDelete} className="text-xs bg-muted hover:bg-red-500/20 hover:text-red-600 border border-border rounded-lg px-3 py-1.5">Del</button>
      </div>
    </div>
  );
}

// ─── Provider Editor ───────────────────────────────────────────────────────
function ProviderEditor({ p, onChange, onRemove }: { p: Provider; onChange: (p: Provider) => void; onRemove: () => void }) {
  return (
    <div className="border border-border rounded-lg p-3 space-y-2 bg-background/50">
      <div className="flex items-center gap-2">
        <input value={p.name} onChange={e => onChange({ ...p, name: e.target.value })} placeholder="Provider name"
          className="flex-1 bg-background border border-border rounded px-2 py-1 text-sm" />
        <select value={p.type} onChange={e => onChange({ ...p, type: e.target.value as 'openai' | 'zai' })}
          className="bg-background border border-border rounded px-2 py-1 text-sm">
          <option value="openai">openai</option>
          <option value="zai">zai</option>
        </select>
        <button onClick={() => onChange({ ...p, enabled: !p.enabled })} className={`px-2 py-1 text-xs rounded border ${p.enabled ? 'bg-green-500/20 text-green-500 border-green-500/30' : 'bg-muted text-muted-foreground border-border'}`}>{p.enabled ? 'ON' : 'OFF'}</button>
        <button onClick={onRemove} className="px-2 py-1 text-xs rounded border bg-red-500/20 text-red-500 border-red-500/30">×</button>
      </div>
      {p.type === 'openai' && (
        <input value={p.proxy_url || ''} onChange={e => onChange({ ...p, proxy_url: e.target.value })} placeholder="Proxy URL"
          className="w-full bg-background border border-border rounded px-2 py-1 text-sm font-mono" />
      )}
      <div className="grid grid-cols-2 gap-2">
        <input value={p.model || ''} onChange={e => onChange({ ...p, model: e.target.value })} placeholder="Model"
          className="bg-background border border-border rounded px-2 py-1 text-sm font-mono" />
        <input value={p.api_key_masked === 'set' ? '••••' : ''} onChange={e => onChange({ ...p, api_key_masked: e.target.value ? 'new' : 'unset' } as any)} placeholder="API key (blank=keep)"
          className="bg-background border border-border rounded px-2 py-1 text-sm font-mono" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-xs">Temp: <input type="number" step="0.05" min="0" max="2" value={p.temperature ?? 0.85} onChange={e => onChange({ ...p, temperature: parseFloat(e.target.value) })} className="w-full bg-background border border-border rounded px-1 py-0.5 text-xs" /></label>
        <label className="text-xs">Max tok: <input type="number" min="50" max="8000" value={p.max_tokens ?? 1500} onChange={e => onChange({ ...p, max_tokens: parseInt(e.target.value) })} className="w-full bg-background border border-border rounded px-1 py-0.5 text-xs" /></label>
        <label className="text-xs">Priority: <input type="number" min="1" max="10" value={p.priority ?? 1} onChange={e => onChange({ ...p, priority: parseInt(e.target.value) })} className="w-full bg-background border border-border rounded px-1 py-0.5 text-xs" /></label>
      </div>
      {p.type === 'zai' && (
        <label className="text-xs flex items-center gap-2">Thinking: <select value={p.zai_thinking || 'disabled'} onChange={e => onChange({ ...p, zai_thinking: e.target.value })} className="bg-background border border-border rounded px-1 py-0.5 text-xs"><option value="disabled">disabled</option><option value="enabled">enabled</option></select></label>
      )}
    </div>
  );
}

// ─── Bot Editor ───────────────────────────────────────────────────────────
function BotEditor({ bot, allBots, onClose, onSaved }: { bot: Bot | null; allBots: Bot[]; onClose: () => void; onSaved: () => void }) {
  const isCreate = !bot;
  const [name, setName] = useState('');
  const [persona, setPersona] = useState('');
  const [token, setToken] = useState('');
  const [guildId, setGuildId] = useState('');
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [prob, setProb] = useState(1.0);
  const [skipPats, setSkipPats] = useState('^\\+$\n^-$\n^(k|kk)$');
  const [cooldown, setCooldown] = useState(2000);
  const [maxCtx, setMaxCtx] = useState(1000000);
  const [delay, setDelay] = useState(0);
  const [ignoreBots, setIgnoreBots] = useState(false);
  const [tools, setTools] = useState({ ...DEFAULT_TOOLS });
  const [delegatedBots, setDelegatedBots] = useState<string[]>([]);
  const [guilds, setGuilds] = useState<any[]>([]);
  const [chLoading, setChLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!bot) return;
    api(`/api/bots/${bot.id}`).then((b: any) => {
      setName(b.name || ''); setPersona(b.persona || ''); setGuildId(b.guild_id || '');
      setChannelIds(b.channel_ids || []); setProviders(b.providers || []);
      setProb(b.gating?.response_probability ?? 1.0);
      setSkipPats((b.gating?.skip_patterns || ['^\\+$', '^-$', '^(k|kk)$']).join('\n'));
      setCooldown(b.gating?.cooldown_ms ?? 2000);
      setMaxCtx(b.gating?.max_context_messages ?? 1000000);
      setDelay(b.gating?.response_delay_ms ?? 0);
      setIgnoreBots(b.gating?.ignore_bots ?? false);
      setTools({ ...DEFAULT_TOOLS, ...(b.tools || {}) });
      setDelegatedBots(b.delegated_bots || []);
    }).catch((e: any) => setError(e.message));
    // Auto-load channels
    api(`/api/bots/${bot.id}/channels`).then((data: any) => {
      if (data.guilds) setGuilds(data.guilds);
    }).catch(() => {});
  }, [bot]);

  const loadChannels = async () => {
    setChLoading(true); setError('');
    try {
      let data: any;
      if (token) {
        data = await api('/api/discord/guilds', { method: 'POST', body: JSON.stringify({ token }) });
      } else if (bot) {
        data = await api(`/api/bots/${bot.id}/channels`);
      } else { setError('Paste token to load channels'); return; }
      setGuilds(data.guilds || []);
    } catch (e) { setError((e as Error).message); }
    finally { setChLoading(false); }
  };

  const save = async (restart: boolean) => {
    setError(''); setSaving(true);
    const body: any = {
      name, persona, guild_id: guildId, channel_ids: channelIds, delegated_bots: delegatedBots,
      providers: providers.map(p => {
        const out: any = { ...p };
        delete out.api_key_masked;
        return out;
      }),
      gating: { response_probability: prob, skip_patterns: skipPats.split('\n').map(s => s.trim()).filter(Boolean), ignore_bots: ignoreBots, max_context_messages: maxCtx, cooldown_ms: cooldown, response_delay_ms: delay },
      tools,
    };
    if (token) body.token = token;
    try {
      if (bot) {
        await api(`/api/bots/${bot.id}`, { method: 'PUT', body: JSON.stringify(body) });
        if (restart) await api(`/api/bots/${bot.id}/restart`, { method: 'POST' });
      } else {
        await api('/api/bots', { method: 'POST', body: JSON.stringify(body) });
      }
      onSaved(); onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 overflow-y-auto" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl w-full max-w-3xl mx-auto my-4 min-h-min" onClick={e => e.stopPropagation()} style={{ maxWidth: '900px' }}>
        <div className="px-6 py-3 border-b border-border flex items-center justify-between sticky top-0 bg-card z-10 rounded-t-2xl">
          <h2 className="font-semibold text-sm">{isCreate ? 'Create New Bot' : `Edit: ${esc(name)}`}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl">×</button>
        </div>
        <div className="p-6 space-y-5">
          {/* Name */}
          <div><label className="block text-xs text-muted-foreground mb-1">Name *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Scylla, Mama, Narrator" className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm" /></div>
          {/* Persona */}
          <div><label className="block text-xs text-muted-foreground mb-1">Persona (system prompt) *</label>
            <textarea value={persona} onChange={e => setPersona(e.target.value)} rows={8} placeholder="You are..." className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono" /></div>
          {/* Token + Load channels */}
          <div><label className="block text-xs text-muted-foreground mb-1">Discord token {isCreate ? '*' : '(blank = keep existing)'}</label>
            <div className="flex gap-2">
              <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="MTUzOTE5..." className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono" />
              <button onClick={loadChannels} disabled={chLoading} className="text-xs bg-primary text-primary-foreground rounded-lg px-3 py-2 whitespace-nowrap disabled:opacity-50">{chLoading ? '...' : '→ Load channels'}</button>
            </div></div>
          {/* Guild ID */}
          <div><label className="block text-xs text-muted-foreground mb-1">Guild ID</label>
            <input value={guildId} onChange={e => setGuildId(e.target.value)} placeholder="1511640846435356794" className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono" /></div>
          {/* Channels */}
          {guilds.length > 0 && (
            <div><label className="block text-xs text-muted-foreground mb-1">Channels (empty = all)</label>
              <div className="max-h-48 overflow-y-auto bg-background border border-border rounded-lg p-2 space-y-1">
                {guilds.map(g => (
                  <div key={g.id}>
                    <div className="text-xs font-semibold text-foreground mt-1 mb-1">{esc(g.name)}</div>
                    {(g.text_channels || []).map((c: any) => (
                      <label key={c.id} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer hover:bg-muted/30 px-1 rounded">
                        <input type="checkbox" checked={channelIds.includes(c.id)} onChange={e => {
                          setChannelIds(e.target.checked ? [...channelIds, c.id] : channelIds.filter(id => id !== c.id));
                          if (e.target.checked && !guildId) setGuildId(g.id);
                        }} className="accent-primary" />
                        <span>#{esc(c.name)}</span>
                        <span className="text-muted-foreground/50 font-mono ml-auto text-[10px]">{c.id}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div></div>
          )}
          {/* Providers */}
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-sm">Providers (racing)</h3>
              <button onClick={() => setProviders([...providers, { id: 'p' + Date.now(), name: 'New Provider', type: 'openai', priority: providers.length + 1, enabled: true, proxy_url: '', model: '', temperature: 0.85, max_tokens: 1500 }])} className="text-xs bg-primary text-primary-foreground rounded px-2 py-1">+ Add</button>
            </div>
            <div className="space-y-2">
              {providers.map((p, i) => (
                <ProviderEditor key={p.id} p={p} onChange={np => setProviders(providers.map((x, idx) => idx === i ? np : x))} onRemove={() => setProviders(providers.filter((_, idx) => idx !== i))} />
              ))}
              {providers.length === 0 && <p className="text-xs text-muted-foreground">No providers. Add one to get started.</p>}
            </div>
          </div>
          {/* Gating */}
          <div className="border-t border-border pt-4">
            <h3 className="font-semibold text-sm mb-2">Behavior</h3>
            <div className="space-y-3">
              <div><label className="text-xs text-muted-foreground">Response probability: {prob}</label>
                <input type="range" min="0" max="1" step="0.05" value={prob} onChange={e => setProb(parseFloat(e.target.value))} className="w-full accent-primary" /></div>
              <div><label className="text-xs text-muted-foreground">Skip patterns (one per line)</label>
                <textarea value={skipPats} onChange={e => setSkipPats(e.target.value)} rows={3} className="w-full bg-background border border-border rounded-lg px-2 py-1 text-sm font-mono" /></div>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs">Cooldown (ms)<input type="number" value={cooldown} onChange={e => setCooldown(parseInt(e.target.value))} className="w-full bg-background border border-border rounded px-2 py-1 text-sm" /></label>
                <label className="text-xs">Max context<input type="number" value={maxCtx} onChange={e => setMaxCtx(parseInt(e.target.value))} className="w-full bg-background border border-border rounded px-2 py-1 text-sm" /></label>
                <label className="text-xs">Delay (ms)<input type="number" value={delay} onChange={e => setDelay(parseInt(e.target.value))} className="w-full bg-background border border-border rounded px-2 py-1 text-sm" /></label>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={ignoreBots} onChange={e => setIgnoreBots(e.target.checked)} className="accent-primary" />
                Ignore other bots (prevents loops)
              </label>
            </div>
          </div>
          {/* Tools */}
          <div className="border-t border-border pt-4">
            <h3 className="font-semibold text-sm mb-2">Tools</h3>
            <div className="grid grid-cols-2 gap-2">
              {Object.keys(TOOL_DESCS).map(k => (
                <label key={k} className="flex items-center justify-between bg-background border border-border rounded-lg px-3 py-2 cursor-pointer hover:bg-muted/30">
                  <span className="text-sm">{TOOL_DESCS[k]}</span>
                  <input type="checkbox" checked={tools[k] ?? false} onChange={e => setTools({ ...tools, [k]: e.target.checked })} className="accent-primary" />
                </label>
              ))}
            </div>
          </div>
          {/* Delegated bots */}
          {allBots.length > 1 && (
            <div className="border-t border-border pt-4">
              <h3 className="font-semibold text-sm mb-2">Delegated bots (can summon)</h3>
              <div className="max-h-32 overflow-y-auto bg-background border border-border rounded-lg p-2 space-y-1">
                {allBots.filter(b => !bot || b.id !== bot.id).map(other => (
                  <label key={other.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/30 px-1 rounded">
                    <input type="checkbox" checked={delegatedBots.includes(other.id)} onChange={e => setDelegatedBots(e.target.checked ? [...delegatedBots, other.id] : delegatedBots.filter(id => id !== other.id))} className="accent-primary" />
                    <span>{esc(other.name)}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {error && <div className="text-xs text-red-500 bg-red-500/10 p-2 rounded">{error}</div>}
        </div>
        <div className="px-6 py-3 border-t border-border flex gap-2 sticky bottom-0 bg-card rounded-b-2xl">
          <button onClick={() => save(false)} disabled={saving} className="flex-1 bg-primary text-primary-foreground rounded-lg py-2 text-sm font-medium disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
          {bot && <button onClick={() => save(true)} disabled={saving || bot.status !== 'running'} className="bg-muted border border-border rounded-lg px-4 py-2 text-sm disabled:opacity-50">Save & Restart</button>}
          <button onClick={onClose} className="bg-muted border border-border rounded-lg px-4 py-2 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Proxies Tab ───────────────────────────────────────────────────────────
function ProxiesTab() {
  const [url, setUrl] = useState('https://lolmaobruhhh-fap.hf.space/v1');
  const [key, setKey] = useState('FAP!');
  const [model, setModel] = useState('idk:gemini-3.7-flash-high-search');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const ping = async () => {
    setLoading(true); setResult(null);
    try { const r = await api('/api/llm/ping', { method: 'POST', body: JSON.stringify({ proxy_url: url, api_key: key, model }) }); setResult(r); }
    catch (e) { setResult({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };
  return (
    <div className="max-w-2xl space-y-4">
      <h3 className="font-semibold text-sm">Test LLM Proxy</h3>
      <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Proxy URL" className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono" />
      <div className="grid grid-cols-2 gap-2">
        <input value={key} onChange={e => setKey(e.target.value)} placeholder="API key" className="bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono" />
        <input value={model} onChange={e => setModel(e.target.value)} placeholder="Model" className="bg-background border border-border rounded-lg px-3 py-2 text-sm font-mono" />
      </div>
      <button onClick={ping} disabled={loading} className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm disabled:opacity-50">{loading ? 'Pinging...' : 'Ping'}</button>
      {result && <pre className="bg-muted/30 border border-border rounded-lg p-3 text-xs font-mono whitespace-pre-wrap max-h-60 overflow-y-auto">{JSON.stringify(result, null, 2)}</pre>}
    </div>
  );
}

// ─── Logs Tab ──────────────────────────────────────────────────────────────
function LogsTab({ bots }: { bots: Bot[] }) {
  const [botId, setBotId] = useState('');
  const [logs, setLogs] = useState<string[]>([]);
  const [auto, setAuto] = useState(false);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => { if (bots.length && !botId) setBotId(bots[0].id); }, [bots]);
  useEffect(() => {
    if (!botId) return;
    const fetchLogs = async () => {
      await new Promise(r => setTimeout(r, 0));
      try { const r = await api(`/api/bots/${botId}/logs?lines=200`); setLogs((r as any).logs || []); }
      catch {}
    };
    fetchLogs();
    if (auto) { const t = setInterval(fetchLogs, 3000); return () => clearInterval(t); }
  }, [botId, auto]);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs]);
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <select value={botId} onChange={e => setBotId(e.target.value)} className="bg-background border border-border rounded-lg px-3 py-2 text-sm">
          {bots.map(b => <option key={b.id} value={b.id}>{esc(b.name)}</option>)}
        </select>
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} className="accent-primary" /> Auto-refresh</label>
      </div>
      <pre ref={ref} className="bg-black/40 border border-border rounded-lg p-3 text-xs font-mono h-[600px] overflow-y-auto whitespace-pre-wrap">
{logs.map(l => { try { const j = JSON.parse(l); return `[${j.ts?.slice(11, 19)}] ${j.level}: ${j.msg}`; } catch { return l; } }).join('\n')}
      </pre>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────
export default function Page() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('bots');
  const [editing, setEditing] = useState<Bot | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { _onUnauthorized = () => setLoggedIn(false); }, []);

  const refresh = useCallback(async () => {
    try { const data = await api('/api/bots'); setBots((data as any).bots || []); }
    catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const t = localStorage.getItem('session_token');
    if (t) { setLoggedIn(true); refresh(); } else { setLoading(false); }
  }, [refresh]);

  const start = async (id: string) => { try { await api(`/api/bots/${id}/start`, { method: 'POST' }); refresh(); } catch (e) { alert((e as Error).message); } };
  const stop = async (id: string) => { try { await api(`/api/bots/${id}/stop`, { method: 'POST' }); refresh(); } catch (e) { alert((e as Error).message); } };
  const restart = async (id: string) => { try { await api(`/api/bots/${id}/restart`, { method: 'POST' }); refresh(); } catch (e) { alert((e as Error).message); } };
  const del = async (id: string) => { if (!confirm('Delete?')) return; try { await api(`/api/bots/${id}`, { method: 'DELETE' }); refresh(); } catch (e) { alert((e as Error).message); } };

  if (!loggedIn) return <Login onLogin={() => { setLoggedIn(true); refresh(); }} />;
  if (loading) return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center text-lg">🤖</div>
            <div><div className="font-semibold text-sm">Bot Fleet</div><div className="text-xs text-muted-foreground">{bots.length} bots · {bots.filter(b => b.status === 'running').length} running</div></div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setTab('bots')} className={`text-xs px-3 py-1 rounded ${tab === 'bots' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>Bots</button>
            <button onClick={() => setTab('proxies')} className={`text-xs px-3 py-1 rounded ${tab === 'proxies' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>Proxies</button>
            <button onClick={() => setTab('logs')} className={`text-xs px-3 py-1 rounded ${tab === 'logs' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}>Logs</button>
            <button onClick={() => { localStorage.removeItem('session_token'); setLoggedIn(false); }} className="text-xs text-muted-foreground px-2">Sign out</button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {tab === 'bots' && (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Your bots</h2>
              <button onClick={() => setCreating(true)} className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-lg">+ New Bot</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {bots.map(b => (
                <BotCard key={b.id} bot={b} onEdit={() => setEditing(b)} onStart={() => start(b.id)} onStop={() => stop(b.id)} onRestart={() => restart(b.id)} onDelete={() => del(b.id)} />
              ))}
            </div>
          </>
        )}
        {tab === 'proxies' && <ProxiesTab />}
        {tab === 'logs' && <LogsTab bots={bots} />}
      </main>

      {(editing || creating) && (
        <BotEditor bot={editing} allBots={bots} onClose={() => { setEditing(null); setCreating(false); }} onSaved={refresh} />
      )}
    </div>
  );
}
