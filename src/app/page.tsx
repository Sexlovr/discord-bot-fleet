'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Plus,
  Trash2,
  RefreshCw,
  Play,
  Square,
  Pencil,
  Server,
  ScrollText,
  LogOut,
  ExternalLink,
  Loader2,
  CheckCircle2,
  XCircle,
  Wifi,
  Cpu,
  Bot as BotIcon,
} from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────────────────
let _onUnauthorized: (() => void) | null = null;

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': localStorage.getItem('session_token') || '',
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
  if (res.status === 401) {
    if (_onUnauthorized) _onUnauthorized();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(s: unknown): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function timeAgo(ts: number | string | Date): string {
  if (!ts) return 'never';
  const d = ts instanceof Date ? ts : new Date(ts);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return d.toLocaleDateString();
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ─── Types ───────────────────────────────────────────────────────────────
interface Provider {
  id: string;
  name: string;
  type: 'openai' | 'zai';
  priority: number;
  enabled: boolean;
  proxy_url: string;
  model: string;
  temperature: number;
  max_tokens: number;
  api_key_masked?: string;
  api_key?: string; // client-side only — typed in by user when rotating
  zai_thinking?: 'enabled' | 'disabled';
}

interface Bot {
  id: string;
  name: string;
  persona: string;
  status: 'stopped' | 'running' | 'error';
  discord_user_id?: string;
  token_masked?: string;
  guild_id: string;
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
    response_delay_ms?: number;
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
  updated_at?: number;
}

interface Guild {
  id: string;
  name: string;
  icon: string | null;
  text_channels: Array<{ id: string; name: string; topic?: string | null }>;
}

const DEFAULT_TOOLS = {
  web_search: true,
  ping_proxy: true,
  fetch_url: true,
  github_lookup: true,
  memory: true,
  schedule_reminder: true,
  react_to_message: true,
  summon_bot: false,
};

const DEFAULT_GATING = {
  response_probability: 1.0,
  skip_patterns: ['^\\+$', '^-$', '^(k|kk)$'],
  ignore_bots: true,
  max_context_messages: 30,
  cooldown_ms: 1500,
  response_delay_ms: 0,
};

const TOOL_LABELS: Array<{ key: keyof Bot['tools']; label: string; desc: string }> = [
  { key: 'web_search', label: 'Web Search', desc: 'Search the web for current info' },
  { key: 'ping_proxy', label: 'Ping Proxy', desc: 'Check LLM proxy health' },
  { key: 'fetch_url', label: 'Fetch URL', desc: 'Read content from URLs' },
  { key: 'github_lookup', label: 'GitHub Lookup', desc: 'Query GitHub repos & users' },
  { key: 'memory', label: 'Memory', desc: 'Persistent long-term memory' },
  { key: 'schedule_reminder', label: 'Schedule Reminder', desc: 'Set timed reminders' },
  { key: 'react_to_message', label: 'React to Message', desc: 'Add emoji reactions' },
  { key: 'summon_bot', label: 'Summon Bot', desc: 'Call other bots into the channel' },
];

// ─── Login screen ────────────────────────────────────────────────────────
function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'login failed');
      localStorage.setItem('session_token', data.token);
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-background to-muted/30">
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-2xl p-8 shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-xl bg-primary/15 flex items-center justify-center text-2xl">🌸</div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Bot Fleet</h1>
              <p className="text-xs text-muted-foreground">Multi-bot Discord control panel</p>
            </div>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pw">Admin password</Label>
              <Input
                id="pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                placeholder="••••••••••••"
              />
            </div>
            <Button type="submit" disabled={loading} className="w-full" size="lg">
              {loading ? <><Loader2 className="size-4 animate-spin" /> Signing in…</> : 'Sign in'}
            </Button>
            {error && <div className="text-xs text-destructive">{error}</div>}
          </form>
          <p className="text-xs text-muted-foreground mt-6 text-center">
            Set <code className="bg-muted px-1 py-0.5 rounded">ADMIN_PASSWORD</code> env var to log in.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Status dot ──────────────────────────────────────────────────────────
function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'running' ? 'bg-green-500 animate-pulse' :
    status === 'error' ? 'bg-red-500' :
    'bg-gray-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />;
}

// ─── Bot card ────────────────────────────────────────────────────────────
function BotCard({ bot, allBots, onEdit, onStart, onStop, onRestart, onDelete }: {
  bot: Bot;
  allBots: Bot[];
  onEdit: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
}) {
  const emoji =
    bot.name.toLowerCase().includes('yuki') || bot.name.toLowerCase().includes('mama') ? '🌸' :
    bot.name.toLowerCase().includes('cod') || bot.name.toLowerCase().includes('dev') ? '💻' :
    bot.name.toLowerCase().includes('admin') ? '🛡️' :
    '🤖';
  const activeProviders = bot.providers.filter((p) => p.enabled);
  const activeNames = activeProviders.map((p) => p.name).join(', ');
  const delegatedNames = bot.delegated_bots
    .map((id) => allBots.find((b) => b.id === id)?.name || id)
    .join(', ');

  return (
    <div className="bg-card border border-border rounded-2xl p-5 hover:border-primary/50 transition flex flex-col">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/30 to-primary/5 flex items-center justify-center text-lg shrink-0">{emoji}</div>
          <div className="min-w-0">
            <div className="font-semibold text-sm text-foreground truncate">{escapeHtml(bot.name)}</div>
            <div className="text-xs text-muted-foreground font-mono truncate">{bot.id}</div>
          </div>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
          <StatusDot status={bot.status} />
          <span className="capitalize">{bot.status}</span>
        </span>
      </div>

      <div className="space-y-1.5 text-xs text-muted-foreground mb-3 flex-1">
        <div className="flex items-center gap-1.5">
          <Server className="size-3 shrink-0" />
          <span>Providers:</span>
          <span className="text-foreground font-medium">{activeProviders.length}/{bot.providers.length}</span>
          {activeNames && <span className="text-foreground/70 truncate">({activeNames})</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-foreground font-medium">#</span>
          <span>Channels:</span>
          <span className="text-foreground font-medium">{bot.channel_ids.length}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <BotIcon className="size-3 shrink-0" />
          <span>Delegates:</span>
          <span className="text-foreground truncate" title={delegatedNames}>{delegatedNames || 'none'}</span>
        </div>
        {bot.updated_at && (
          <div className="flex items-center gap-1.5">
            <RefreshCw className="size-3 shrink-0" />
            <span>Updated:</span>
            <span className="text-foreground">{timeAgo(bot.updated_at)}</span>
          </div>
        )}
      </div>

      <div className="flex gap-1 pt-3 border-t border-border">
        {bot.status === 'running' ? (
          <Button onClick={onStop} variant="ghost" size="sm" className="flex-1 hover:bg-yellow-500/15 hover:text-yellow-500">
            <Square className="size-3" /> Stop
          </Button>
        ) : (
          <Button onClick={onStart} variant="ghost" size="sm" className="flex-1 hover:bg-green-500/15 hover:text-green-500">
            <Play className="size-3" /> Start
          </Button>
        )}
        {bot.status === 'running' && (
          <Button onClick={onRestart} variant="ghost" size="sm" title="Restart" className="hover:bg-primary/15 hover:text-primary">
            <RefreshCw className="size-3" />
          </Button>
        )}
        <Button onClick={onEdit} variant="ghost" size="sm" className="flex-1 hover:bg-primary/15 hover:text-primary">
          <Pencil className="size-3" /> Edit
        </Button>
        <Button onClick={onDelete} variant="ghost" size="sm" title="Delete" className="hover:bg-red-500/15 hover:text-red-500">
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}

// ─── Bot editor / create modal ───────────────────────────────────────────
function BotEditorModal({
  bot,        // null = create mode
  allBots,
  onClose,
  onSaved,
}: {
  bot: Bot | null;
  allBots: Bot[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isCreate = !bot;
  const [name, setName] = useState(bot?.name || '');
  const [persona, setPersona] = useState(bot?.persona || '');
  const [token, setToken] = useState('');
  const [guildId, setGuildId] = useState(bot?.guild_id || '');
  const [channelIds, setChannelIds] = useState<string[]>(bot?.channel_ids || []);
  const [delegatedBots, setDelegatedBots] = useState<string[]>(bot?.delegated_bots || []);

  const [providers, setProviders] = useState<Provider[]>(
    bot?.providers?.length
      ? bot.providers.map((p) => ({ ...p, api_key: '' }))
      : []
  );

  const [gating, setGating] = useState({
    response_probability: bot?.gating?.response_probability ?? DEFAULT_GATING.response_probability,
    skip_patterns_text: (bot?.gating?.skip_patterns ?? DEFAULT_GATING.skip_patterns).join('\n'),
    ignore_bots: bot?.gating?.ignore_bots ?? DEFAULT_GATING.ignore_bots,
    max_context_messages: bot?.gating?.max_context_messages ?? DEFAULT_GATING.max_context_messages,
    cooldown_ms: bot?.gating?.cooldown_ms ?? DEFAULT_GATING.cooldown_ms,
    response_delay_ms: bot?.gating?.response_delay_ms ?? DEFAULT_GATING.response_delay_ms,
  });

  const [tools, setTools] = useState<Bot['tools']>(bot?.tools || { ...DEFAULT_TOOLS });

  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [autoLoaded, setAutoLoaded] = useState(false);

  // Auto-load channels on editor open using the stored token (edit mode only)
  useEffect(() => {
    if (isCreate || autoLoaded) return;
    setAutoLoaded(true);
    let cancelled = false;
    (async () => {
      setChannelsLoading(true);
      setChannelsError('');
      try {
        const data = await api(`/api/bots/${bot!.id}/channels`);
        if (!cancelled) setGuilds((data as { guilds: Guild[] }).guilds || []);
      } catch (e) {
        if (!cancelled) setChannelsError((e as Error).message);
      } finally {
        if (!cancelled) setChannelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadChannels = async () => {
    setChannelsLoading(true);
    setChannelsError('');
    try {
      let data;
      if (token.trim()) {
        // Use the manually pasted token to load guilds
        data = await api('/api/discord/guilds', {
          method: 'POST',
          body: JSON.stringify({ token: token.trim() }),
        });
      } else if (!isCreate) {
        // Re-load using the stored token
        data = await api(`/api/bots/${bot!.id}/channels`);
      } else {
        throw new Error('Paste a bot token first to load channels');
      }
      setGuilds((data as { guilds: Guild[] }).guilds || []);
    } catch (e) {
      setChannelsError((e as Error).message);
    } finally {
      setChannelsLoading(false);
    }
  };

  const toggleChannel = (id: string) => {
    setChannelIds((prev) => prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]);
  };
  const toggleGuildAll = (g: Guild) => {
    const ids = g.text_channels.map((c) => c.id);
    const allSelected = ids.every((id) => channelIds.includes(id));
    if (allSelected) {
      setChannelIds((prev) => prev.filter((id) => !ids.includes(id)));
    } else {
      setChannelIds((prev) => Array.from(new Set([...prev, ...ids])));
    }
  };
  const toggleDelegate = (id: string) => {
    setDelegatedBots((prev) => prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]);
  };

  const updateProvider = (id: string, patch: Partial<Provider>) => {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };
  const addProvider = () => {
    setProviders((prev) => [
      ...prev,
      {
        id: uid(),
        name: `Provider ${prev.length + 1}`,
        type: 'openai',
        priority: prev.length + 1,
        enabled: true,
        proxy_url: 'https://lolmaobruhhh-fap.hf.space/v1',
        model: 'idk:gemini-3.6-flash-high-search',
        temperature: 0.85,
        max_tokens: 1500,
        api_key: '',
        api_key_masked: '',
        zai_thinking: 'disabled',
      },
    ]);
  };
  const removeProvider = (id: string) => {
    setProviders((prev) => prev.filter((p) => p.id !== id));
  };

  const buildPayload = (includeToken: boolean) => {
    const payload: Record<string, unknown> = {
      name,
      persona,
      guild_id: guildId,
      channel_ids: channelIds,
      delegated_bots: delegatedBots,
      providers: providers.map((p) => {
        const out: Record<string, unknown> = {
          id: p.id,
          name: p.name,
          type: p.type,
          priority: p.priority,
          enabled: p.enabled,
          proxy_url: p.proxy_url,
          model: p.model,
          temperature: p.temperature,
          max_tokens: p.max_tokens,
        };
        if (p.type === 'zai') out.zai_thinking = p.zai_thinking || 'disabled';
        // Only send api_key if user typed a new value
        if (typeof p.api_key === 'string' && p.api_key !== '') {
          out.api_key = p.api_key;
        }
        return out;
      }),
      gating: {
        response_probability: gating.response_probability,
        skip_patterns: gating.skip_patterns_text.split('\n').map((s) => s.trim()).filter(Boolean),
        ignore_bots: gating.ignore_bots,
        max_context_messages: Number(gating.max_context_messages),
        cooldown_ms: Number(gating.cooldown_ms),
        response_delay_ms: Number(gating.response_delay_ms),
      },
      tools,
    };
    if (includeToken && token.trim()) {
      payload.token = token.trim();
    }
    return payload;
  };

  const save = async (restart: boolean) => {
    setSaveError('');
    if (!name.trim() || !persona.trim()) {
      setSaveError('Name and persona are required');
      return;
    }
    if (isCreate && !token.trim()) {
      setSaveError('Bot token is required to create a new bot');
      return;
    }
    setSaving(true);
    try {
      if (isCreate) {
        const payload = buildPayload(true);
        await api('/api/bots', { method: 'POST', body: JSON.stringify(payload) });
      } else {
        const payload = buildPayload(token.trim() !== '');
        await api(`/api/bots/${bot!.id}`, { method: 'PUT', body: JSON.stringify(payload) });
        if (restart) {
          await api(`/api/bots/${bot!.id}/restart`, { method: 'POST' });
        }
      }
      onSaved();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl w-[95vw] max-h-[92vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b border-border shrink-0">
          <DialogTitle className="flex items-center gap-2">
            {isCreate ? <Plus className="size-5" /> : <Pencil className="size-5" />}
            {isCreate ? 'Create New Bot' : `Edit ${bot!.name}`}
          </DialogTitle>
          <DialogDescription>
            {isCreate
              ? 'Configure a new Discord bot with multi-provider LLM support.'
              : (
                <>
                  Bot ID: <code className="bg-muted px-1 py-0.5 rounded">{bot!.id}</code>
                  {bot!.token_masked && (
                    <>
                      {' · token: '}
                      <code className="bg-muted px-1 py-0.5 rounded">{bot!.token_masked}</code>
                    </>
                  )}
                </>
              )}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 max-h-[calc(92vh-9rem)]">
          <div className="px-6 py-5 space-y-7">

            {/* ── Basic ─────────────────────────────────────── */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <BotIcon className="size-4 text-primary" /> Basic
              </h3>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name *</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Yuki-chan" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="guild">Guild ID</Label>
                  <Input id="guild" value={guildId} onChange={(e) => setGuildId(e.target.value)} placeholder="123456789012345678" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="persona">Persona *</Label>
                <Textarea
                  id="persona"
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  rows={4}
                  placeholder="You are a helpful, friendly bot..."
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="token">
                  Discord Bot Token {!isCreate && <span className="text-xs text-muted-foreground font-normal">(blank = keep existing)</span>}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={isCreate ? 'MTUz...' : (bot?.token_masked ? `keep ${bot.token_masked}` : 'MTUz...')}
                    className="font-mono text-xs flex-1"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={loadChannels} disabled={channelsLoading}>
                    {channelsLoading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                    Load channels
                  </Button>
                </div>
                {channelsError && <p className="text-xs text-destructive">{channelsError}</p>}
              </div>
            </section>

            {/* ── Channels ──────────────────────────────────── */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Server className="size-4 text-primary" /> Channels
                  <Badge variant="secondary" className="text-xs">{channelIds.length} selected</Badge>
                </h3>
                {!channelsLoading && guilds.length > 0 && (
                  <Button type="button" variant="ghost" size="sm" onClick={loadChannels}>
                    <RefreshCw className="size-3" /> Reload
                  </Button>
                )}
              </div>
              {channelsLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                  <Loader2 className="size-4 animate-spin" /> Loading channels…
                </div>
              )}
              {!channelsLoading && guilds.length === 0 && (
                <div className="text-xs text-muted-foreground py-4 text-center bg-muted/30 rounded-lg border border-dashed border-border">
                  No channels loaded. {isCreate ? 'Paste a token and click "Load channels".' : 'Click "Load channels" to fetch from stored token.'}
                </div>
              )}
              {!channelsLoading && guilds.length > 0 && (
                <div className="space-y-3 max-h-72 overflow-y-auto pr-1 custom-scroll">
                  {guilds.map((g) => {
                    const allSelected = g.text_channels.length > 0 && g.text_channels.every((c) => channelIds.includes(c.id));
                    const someSelected = g.text_channels.some((c) => channelIds.includes(c.id));
                    return (
                      <div key={g.id} className="border border-border rounded-lg overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50">
                          <Checkbox
                            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                            onCheckedChange={() => toggleGuildAll(g)}
                          />
                          <span className="text-xs font-medium text-foreground flex-1 truncate">
                            {g.icon && <img src={g.icon} alt="" className="inline size-4 rounded mr-1.5" />}
                            {escapeHtml(g.name)}
                          </span>
                          <Badge variant="outline" className="text-[10px]">{g.text_channels.length} ch</Badge>
                        </div>
                        <div className="grid sm:grid-cols-2 gap-1 p-2">
                          {g.text_channels.map((c) => (
                            <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent/50 cursor-pointer text-xs">
                              <Checkbox
                                checked={channelIds.includes(c.id)}
                                onCheckedChange={() => toggleChannel(c.id)}
                              />
                              <span className="text-foreground truncate flex-1"># {escapeHtml(c.name)}</span>
                              <code className="text-[10px] text-muted-foreground">{c.id}</code>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── Providers ──────────────────────────────────── */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <Cpu className="size-4 text-primary" /> LLM Providers
                  <Badge variant="secondary" className="text-xs">{providers.filter((p) => p.enabled).length}/{providers.length} active</Badge>
                </h3>
                <Button type="button" variant="outline" size="sm" onClick={addProvider}>
                  <Plus className="size-3.5" /> Add provider
                </Button>
              </div>
              {providers.length === 0 && (
                <div className="text-xs text-muted-foreground py-4 text-center bg-muted/30 rounded-lg border border-dashed border-border">
                  No providers yet. Click "Add provider" to configure one.
                </div>
              )}
              <div className="space-y-3">
                {providers.map((p, idx) => (
                  <div key={p.id} className="border border-border rounded-lg p-4 space-y-3 bg-card/50">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground font-mono">#{idx + 1}</span>
                      <Input
                        value={p.name}
                        onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                        className="h-8 flex-1"
                        placeholder="Provider name"
                      />
                      <Select value={p.type} onValueChange={(v) => updateProvider(p.id, { type: v as 'openai' | 'zai' })}>
                        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openai">OpenAI</SelectItem>
                          <SelectItem value="zai">z.ai</SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="flex items-center gap-1.5 px-2">
                        <Switch checked={p.enabled} onCheckedChange={(v) => updateProvider(p.id, { enabled: v })} />
                        <span className="text-xs text-muted-foreground w-12">{p.enabled ? 'on' : 'off'}</span>
                      </div>
                      <Button type="button" variant="ghost" size="icon" className="size-8 hover:bg-red-500/15 hover:text-red-500" onClick={() => removeProvider(p.id)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>

                    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[11px] text-muted-foreground">Priority</Label>
                        <Input
                          type="number"
                          value={p.priority}
                          min={1}
                          onChange={(e) => updateProvider(p.id, { priority: Number(e.target.value) })}
                          className="h-8"
                        />
                      </div>
                      {p.type === 'openai' && (
                        <>
                          <div className="space-y-1 sm:col-span-2">
                            <Label className="text-[11px] text-muted-foreground">Proxy URL</Label>
                            <Input
                              value={p.proxy_url}
                              onChange={(e) => updateProvider(p.id, { proxy_url: e.target.value })}
                              className="h-8 font-mono text-xs"
                              placeholder="https://proxy.example.com/v1"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">Model</Label>
                            <Input
                              value={p.model}
                              onChange={(e) => updateProvider(p.id, { model: e.target.value })}
                              className="h-8 font-mono text-xs"
                              placeholder="gpt-4o-mini"
                            />
                          </div>
                          <div className="space-y-1 sm:col-span-2">
                            <Label className="text-[11px] text-muted-foreground">
                              API Key {p.api_key_masked && p.api_key_masked !== 'unset' && <span className="text-muted-foreground/70">(currently {p.api_key_masked})</span>}
                            </Label>
                            <Input
                              type="password"
                              value={p.api_key || ''}
                              onChange={(e) => updateProvider(p.id, { api_key: e.target.value })}
                              className="h-8 font-mono text-xs"
                              placeholder={p.api_key_masked && p.api_key_masked !== 'unset' ? 'leave blank to keep' : 'sk-...'}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">Temperature</Label>
                            <Input
                              type="number"
                              step={0.05}
                              min={0}
                              max={2}
                              value={p.temperature}
                              onChange={(e) => updateProvider(p.id, { temperature: Number(e.target.value) })}
                              className="h-8"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-[11px] text-muted-foreground">Max tokens</Label>
                            <Input
                              type="number"
                              value={p.max_tokens}
                              onChange={(e) => updateProvider(p.id, { max_tokens: Number(e.target.value) })}
                              className="h-8"
                            />
                          </div>
                        </>
                      )}
                      {p.type === 'zai' && (
                        <div className="space-y-1 sm:col-span-2 lg:col-span-4">
                          <Label className="text-[11px] text-muted-foreground">z.ai thinking mode</Label>
                          <Select
                            value={p.zai_thinking || 'disabled'}
                            onValueChange={(v) => updateProvider(p.id, { zai_thinking: v as 'enabled' | 'disabled' })}
                          >
                            <SelectTrigger className="h-8 w-full sm:w-48">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="enabled">Enabled (uses thinking tokens)</SelectItem>
                              <SelectItem value="disabled">Disabled</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-[10px] text-muted-foreground">z.ai providers use the platform API key; no proxy_url or api_key needed.</p>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* ── Gating ────────────────────────────────────── */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Server className="size-4 text-primary" /> Gating
              </h3>
              <div className="bg-card/50 border border-border rounded-lg p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Response probability</Label>
                    <Badge variant="outline" className="text-xs font-mono">{(gating.response_probability * 100).toFixed(0)}%</Badge>
                  </div>
                  <Slider
                    min={0}
                    max={100}
                    step={5}
                    value={[Math.round(gating.response_probability * 100)]}
                    onValueChange={(v) => setGating((g) => ({ ...g, response_probability: v[0] / 100 }))}
                  />
                  <p className="text-[10px] text-muted-foreground">Chance the bot responds to a triggering message. 100% = always.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="skip" className="text-xs">Skip patterns (one regex per line)</Label>
                  <Textarea
                    id="skip"
                    value={gating.skip_patterns_text}
                    onChange={(e) => setGating((g) => ({ ...g, skip_patterns_text: e.target.value }))}
                    rows={3}
                    className="font-mono text-xs"
                    placeholder={'^\\+$\n^-$\n^(k|kk)$'}
                  />
                </div>
                <div className="grid sm:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Cooldown (ms)</Label>
                    <Input
                      type="number"
                      value={gating.cooldown_ms}
                      onChange={(e) => setGating((g) => ({ ...g, cooldown_ms: Number(e.target.value) }))}
                      className="h-8"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Max context msgs</Label>
                    <Input
                      type="number"
                      value={gating.max_context_messages}
                      onChange={(e) => setGating((g) => ({ ...g, max_context_messages: Number(e.target.value) }))}
                      className="h-8"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Response delay (ms)</Label>
                    <Input
                      type="number"
                      value={gating.response_delay_ms}
                      onChange={(e) => setGating((g) => ({ ...g, response_delay_ms: Number(e.target.value) }))}
                      className="h-8"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <Label className="text-xs">Ignore bot messages</Label>
                    <p className="text-[10px] text-muted-foreground">Skip messages from other Discord bots</p>
                  </div>
                  <Switch
                    checked={gating.ignore_bots}
                    onCheckedChange={(v) => setGating((g) => ({ ...g, ignore_bots: v }))}
                  />
                </div>
              </div>
            </section>

            {/* ── Tools ─────────────────────────────────────── */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <Cpu className="size-4 text-primary" /> Tools
              </h3>
              <div className="grid sm:grid-cols-2 gap-2">
                {TOOL_LABELS.map(({ key, label, desc }) => (
                  <div key={key} className="flex items-center justify-between rounded-md border border-border p-3 bg-card/50">
                    <div className="min-w-0 pr-2">
                      <div className="text-xs font-medium text-foreground">{label}</div>
                      <div className="text-[10px] text-muted-foreground truncate">{desc}</div>
                    </div>
                    <Switch
                      checked={tools[key]}
                      onCheckedChange={(v) => setTools((t) => ({ ...t, [key]: v }))}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* ── Delegated bots ────────────────────────────── */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                  <BotIcon className="size-4 text-primary" /> Delegated Bots
                  <Badge variant="secondary" className="text-xs">{delegatedBots.length} selected</Badge>
                </h3>
              </div>
              {allBots.filter((b) => b.id !== bot?.id).length === 0 ? (
                <div className="text-xs text-muted-foreground py-3 text-center bg-muted/30 rounded-lg border border-dashed border-border">
                  No other bots available to delegate to.
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-1 max-h-40 overflow-y-auto pr-1">
                  {allBots
                    .filter((b) => b.id !== bot?.id)
                    .map((b) => (
                      <label key={b.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent/50 cursor-pointer text-xs">
                        <Checkbox
                          checked={delegatedBots.includes(b.id)}
                          onCheckedChange={() => toggleDelegate(b.id)}
                        />
                        <span className="text-foreground truncate">{escapeHtml(b.name)}</span>
                        <code className="text-[10px] text-muted-foreground ml-auto">{b.id}</code>
                      </label>
                    ))}
                </div>
              )}
            </section>

            {saveError && (
              <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2">
                {saveError}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="px-6 py-4 border-t border-border shrink-0 bg-card/30">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          {!isCreate && (
            <Button variant="outline" onClick={() => save(true)} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Save & Restart
            </Button>
          )}
          <Button onClick={() => save(false)} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            {isCreate ? 'Create Bot' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Proxies tab ─────────────────────────────────────────────────────────
function ProxiesTab() {
  const [proxyUrl, setProxyUrl] = useState('https://lolmaobruhhh-fap.hf.space/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('idk:gemini-3.6-flash-high-search');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ status?: string; latency_ms?: number; models?: string[]; test_response?: string; error?: string } | null>(null);
  const [error, setError] = useState('');

  const ping = async () => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await api('/api/llm/ping', {
        method: 'POST',
        body: JSON.stringify({ proxy_url: proxyUrl, api_key: apiKey, model }),
      });
      setResult(data as typeof result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="bg-card border border-border rounded-2xl p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-foreground flex items-center gap-2">
            <Wifi className="size-4 text-primary" /> Test LLM Proxy
          </h3>
          <p className="text-xs text-muted-foreground mt-1">Check the health and latency of an OpenAI-compatible endpoint.</p>
        </div>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="px-url">Proxy URL</Label>
            <Input
              id="px-url"
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              className="font-mono text-xs"
              placeholder="https://proxy.example.com/v1"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="px-key">API Key <span className="text-muted-foreground font-normal">(optional — server falls back to env)</span></Label>
            <Input
              id="px-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-mono text-xs"
              placeholder="sk-..."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="px-model">Model</Label>
            <Input
              id="px-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="font-mono text-xs"
              placeholder="gpt-4o-mini"
            />
          </div>
          <Button onClick={ping} disabled={loading || !proxyUrl} className="w-full">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Wifi className="size-4" />}
            Ping proxy
          </Button>
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2 flex items-start gap-2">
              <XCircle className="size-3.5 mt-0.5 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-2xl p-6 space-y-3">
        <h3 className="font-semibold text-foreground flex items-center gap-2">
          <Cpu className="size-4 text-primary" /> Result
        </h3>
        {!result && !loading && (
          <div className="text-xs text-muted-foreground py-8 text-center">Run a ping to see the response.</div>
        )}
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-8 justify-center">
            <Loader2 className="size-4 animate-spin" /> Pinging…
          </div>
        )}
        {result && (
          <div className="space-y-3 text-xs">
            <div className="flex items-center gap-2">
              {result.status === 'online' ? (
                <Badge className="bg-green-500/15 text-green-500 border-green-500/30"><CheckCircle2 className="size-3" /> Online</Badge>
              ) : (
                <Badge variant="destructive"><XCircle className="size-3" /> {result.status || 'error'}</Badge>
              )}
              {typeof result.latency_ms === 'number' && (
                <Badge variant="outline" className="font-mono">{result.latency_ms}ms</Badge>
              )}
            </div>
            {result.models && result.models.length > 0 && (
              <div>
                <div className="text-muted-foreground mb-1">Available models ({result.models.length}):</div>
                <div className="max-h-40 overflow-y-auto border border-border rounded p-2 bg-muted/30 custom-scroll space-y-0.5">
                  {result.models.map((m) => (
                    <div key={m} className="font-mono text-[11px] text-foreground truncate">{m}</div>
                  ))}
                </div>
              </div>
            )}
            {result.test_response && (
              <div>
                <div className="text-muted-foreground mb-1">Test response:</div>
                <pre className="font-mono text-[11px] text-foreground bg-muted/30 border border-border rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-y-auto custom-scroll">
                  {escapeHtml(result.test_response)}
                </pre>
              </div>
            )}
            {result.error && (
              <div className="text-destructive bg-destructive/10 border border-destructive/30 rounded p-2 break-words">
                {escapeHtml(result.error)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Logs tab ────────────────────────────────────────────────────────────
function LogsTab({ bots }: { bots: Bot[] }) {
  const [selectedId, setSelectedId] = useState<string>('');
  const [logs, setLogs] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lines, setLines] = useState(200);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const fetchLogs = useCallback(async () => {
    if (!selectedId) return;
    try {
      const data = await api(`/api/bots/${selectedId}/logs?lines=${lines}`);
      setLogs((data as { logs: string[] }).logs || []);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [selectedId, lines]);

  // Auto-select first bot
  useEffect(() => {
    if (!selectedId && bots.length > 0) setSelectedId(bots[0].id);
  }, [bots, selectedId]);

  // Fetch on selection / line-count change
  useEffect(() => {
    if (!selectedId) return;
    setLoading(true);
    fetchLogs();
  }, [selectedId, lines, fetchLogs]);

  // Auto-refresh polling
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!selectedId || !autoRefresh) return;
    intervalRef.current = setInterval(fetchLogs, 2500);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [selectedId, autoRefresh, fetchLogs]);

  // Stick to bottom when new logs arrive
  useEffect(() => {
    if (stickToBottom.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickToBottom.current = atBottom;
  };

  const selectedBot = bots.find((b) => b.id === selectedId);

  return (
    <div className="space-y-4">
      <div className="bg-card border border-border rounded-2xl p-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5 flex-1 min-w-[200px]">
          <Label className="text-xs">Bot</Label>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={bots.length === 0 ? 'No bots available' : 'Select a bot…'} />
            </SelectTrigger>
            <SelectContent>
              {bots.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  <span className="flex items-center gap-2">
                    <StatusDot status={b.status} />
                    {escapeHtml(b.name)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 w-28">
          <Label className="text-xs">Lines</Label>
          <Select value={String(lines)} onValueChange={(v) => setLines(Number(v))}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="100">100</SelectItem>
              <SelectItem value="200">200</SelectItem>
              <SelectItem value="500">500</SelectItem>
              <SelectItem value="1000">1000</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 h-9 px-3 rounded-md border border-border bg-muted/30">
          <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} id="ar" />
          <Label htmlFor="ar" className="text-xs cursor-pointer">Auto-refresh (2.5s)</Label>
        </div>
        <Button variant="outline" size="sm" onClick={fetchLogs} disabled={!selectedId || loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh now
        </Button>
        {selectedBot && (
          <Badge variant="outline" className="text-xs">
            <StatusDot status={selectedBot.status} /> {selectedBot.status}
          </Badge>
        )}
      </div>

      <div className="bg-card border border-border rounded-2xl overflow-hidden">
        <div className="px-4 py-2 border-b border-border bg-muted/30 flex items-center justify-between">
          <span className="text-xs font-mono text-muted-foreground">
            {selectedId ? `${selectedId}.log` : 'no bot selected'}
          </span>
          <span className="text-xs text-muted-foreground">{logs.length} lines</span>
        </div>
        {error ? (
          <div className="p-4 text-xs text-destructive">{error}</div>
        ) : !selectedId ? (
          <div className="p-8 text-xs text-muted-foreground text-center">Select a bot to view its logs.</div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-xs text-muted-foreground text-center">No logs yet. Start the bot to generate output.</div>
        ) : (
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="font-mono text-[11px] leading-relaxed p-3 overflow-y-auto max-h-[60vh] custom-scroll bg-background/50"
          >
            {logs.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all hover:bg-accent/30 px-1 -mx-1 rounded">
                <span className="text-muted-foreground/50 select-none mr-2">{String(i + 1).padStart(4, ' ')}</span>
                <span className={
                  line.includes('ERROR') || line.includes('error') ? 'text-red-400' :
                  line.includes('WARN') || line.includes('warn') ? 'text-yellow-400' :
                  line.includes('ready') || line.includes('Ready') || line.includes('online') ? 'text-green-400' :
                  'text-foreground'
                }>{escapeHtml(line)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────
export default function Page() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('bots');
  const [editing, setEditing] = useState<Bot | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    _onUnauthorized = () => setLoggedIn(false);
  }, []);

  const refreshBots = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/api/bots');
      setBots((data as { bots: Bot[] }).bots);
    } catch { /* handled */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = localStorage.getItem('session_token');
    if (t) {
      Promise.resolve().then(() => {
        setLoggedIn(true);
        refreshBots();
      });
    } else {
      Promise.resolve().then(() => setLoading(false));
    }
  }, []);

  const startBot = async (id: string) => {
    try { await api(`/api/bots/${id}/start`, { method: 'POST' }); await refreshBots(); }
    catch (e) { alert('Failed to start: ' + (e as Error).message); }
  };
  const stopBot = async (id: string) => {
    try { await api(`/api/bots/${id}/stop`, { method: 'POST' }); await refreshBots(); }
    catch (e) { alert('Failed to stop: ' + (e as Error).message); }
  };
  const restartBot = async (id: string) => {
    try { await api(`/api/bots/${id}/restart`, { method: 'POST' }); await refreshBots(); }
    catch (e) { alert('Failed to restart: ' + (e as Error).message); }
  };
  const deleteBot = async (id: string) => {
    if (!confirm('Delete this bot? This cannot be undone.')) return;
    try { await api(`/api/bots/${id}`, { method: 'DELETE' }); await refreshBots(); }
    catch (e) { alert('Failed to delete: ' + (e as Error).message); }
  };

  if (!loggedIn) {
    return <LoginScreen onLogin={() => { setLoggedIn(true); refreshBots(); }} />;
  }

  if (loading && bots.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground gap-2">
        <Loader2 className="size-5 animate-spin" /> Loading…
      </div>
    );
  }

  const runningCount = bots.filter((b) => b.status === 'running').length;

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-background to-muted/20">
      <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center text-lg shrink-0">🌸</div>
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">Bot Fleet</div>
              <div className="text-xs text-muted-foreground truncate">
                {bots.length} bot(s) · <span className="text-green-500">{runningCount} running</span>
              </div>
            </div>
          </div>
          <div className="flex gap-1 sm:gap-2 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => window.open('https://discord.com/developers/applications', '_blank')}
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              <span className="hidden sm:inline">Dev Portal</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { localStorage.removeItem('session_token'); setLoggedIn(false); }}
              className="text-muted-foreground hover:text-foreground"
            >
              <LogOut className="size-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col">
        <div className="max-w-7xl w-full mx-auto px-4 pt-4">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="bots" className="flex-1 sm:flex-initial">
              <BotIcon className="size-3.5" /> Bots
            </TabsTrigger>
            <TabsTrigger value="proxies" className="flex-1 sm:flex-initial">
              <Wifi className="size-3.5" /> LLM Proxies
            </TabsTrigger>
            <TabsTrigger value="logs" className="flex-1 sm:flex-initial">
              <ScrollText className="size-3.5" /> Logs
            </TabsTrigger>
          </TabsList>
        </div>

        <main className="max-w-7xl w-full mx-auto px-4 py-6 flex-1 w-full">
          <TabsContent value="bots" className="mt-0">
            <div className="flex items-center justify-between mb-4 gap-3">
              <h2 className="text-lg font-semibold">Your bots</h2>
              <Button onClick={() => setCreating(true)} size="sm">
                <Plus className="size-4" /> New Bot
              </Button>
            </div>
            {bots.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <div className="text-5xl mb-3">🌸</div>
                <p className="text-sm mb-1">No bots yet.</p>
                <p className="text-xs mb-4">Create your first Discord bot to get started.</p>
                <Button onClick={() => setCreating(true)} size="sm">
                  <Plus className="size-4" /> Create your first bot
                </Button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {bots.map((b) => (
                  <BotCard
                    key={b.id}
                    bot={b}
                    allBots={bots}
                    onEdit={() => setEditing(b)}
                    onStart={() => startBot(b.id)}
                    onStop={() => stopBot(b.id)}
                    onRestart={() => restartBot(b.id)}
                    onDelete={() => deleteBot(b.id)}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="proxies" className="mt-0">
            <ProxiesTab />
          </TabsContent>

          <TabsContent value="logs" className="mt-0">
            <LogsTab bots={bots} />
          </TabsContent>
        </main>
      </Tabs>

      <footer className="border-t border-border bg-card/30 mt-auto">
        <div className="max-w-7xl mx-auto px-4 py-4 text-xs text-muted-foreground text-center">
          Discord Bot Fleet · WebSocket-native · z.ai hosted
        </div>
      </footer>

      {(editing || creating) && (
        <BotEditorModal
          bot={editing}
          allBots={bots}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            refreshBots();
          }}
        />
      )}
    </div>
  );
}
