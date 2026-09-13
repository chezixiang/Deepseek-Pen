import { useEffect, useState } from 'react';
import { apiFetchConfig, apiSaveConfig, type FullConfig } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Plus,
  Save,
  X,
  Server,
  Cpu,
  Globe,
  Key,
  User,
  Shield,
  Tags,
} from 'lucide-react';

function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'sk-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Collapsible section wrapper */
function Section({
  title,
  icon: Icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ElementType;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icon className="h-5 w-5" />
          {title}
          <span className="ml-auto text-muted-foreground">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        </CardTitle>
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  );
}

export function ConfigPage() {
  const [config, setConfig] = useState<FullConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Record<number, boolean>>({});
  const [revealedPasswords, setRevealedPasswords] = useState<Record<number, boolean>>({});
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const loadConfig = () => {
    apiFetchConfig()
      .then(setConfig)
      .catch(() => setMessage({ type: 'err', text: '加载配置失败' }));
  };

  useEffect(loadConfig, []);

  if (!config) {
    return <div className="p-4 text-muted-foreground">加载中...</div>;
  }

  const update = <T,>(path: string[], value: T) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as unknown as Record<string, unknown>;
      let obj: Record<string, unknown> = next;
      for (let i = 0; i < path.length - 1; i++) {
        obj = obj[path[i]] as Record<string, unknown>;
      }
      obj[path[path.length - 1]] = value as unknown;
      return next as unknown as FullConfig;
    });
};

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        server: config.server,
        deepseek: config.deepseek,
        proxy: config.proxy,
        admin: {
          password_hash: '',
          jwt_secret: '',
          jwt_issued_at: config.admin.jwt_issued_at,
          old_password: oldPassword,
          new_password: newPassword,
        },
        accounts: config.accounts,
        api_keys: config.api_keys.map(k => ({
          key: k.key,
          description: k.description,
        })),
      };
      const res = await apiSaveConfig(body);
      if (res.ok) {
        setMessage({ type: 'ok', text: '保存成功，配置已热重载' });
        setRevealedKeys({});
        setOldPassword('');
        setNewPassword('');
        const fresh = await apiFetchConfig();
        setConfig(fresh);
      }
    } catch (e: unknown) {
      setMessage({ type: 'err', text: `保存失败: ${e instanceof Error ? e.message : e}` });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (confirm('放弃所有未保存的修改？')) {
      setRevealedKeys({});
      loadConfig();
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">配置编辑</h1>

      {message && (
        <div
          className={`p-3 rounded-md text-sm ${
            message.type === 'err' ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* ── Accounts (always visible) ──────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <User className="h-5 w-5" /> 账号
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {config.accounts.map((a, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 p-3 border rounded-md">
              <div className="flex-1 min-w-[120px]">
                <label className="text-xs text-muted-foreground">邮箱</label>
                <Input
                  value={a.email}
                  onChange={(e) => {
                    const next = [...config.accounts];
                    next[i] = { ...next[i], email: e.target.value };
                    update(['accounts'], next);
                  }}
                />
              </div>
              <div className="w-24">
                <label className="text-xs text-muted-foreground">手机</label>
                <Input
                  value={a.mobile}
                  onChange={(e) => {
                    const next = [...config.accounts];
                    next[i] = { ...next[i], mobile: e.target.value };
                    update(['accounts'], next);
                  }}
                />
              </div>
              <div className="w-20">
                <label className="text-xs text-muted-foreground">区号</label>
                <Input
                  value={a.area_code}
                  onChange={(e) => {
                    const next = [...config.accounts];
                    next[i] = { ...next[i], area_code: e.target.value };
                    update(['accounts'], next);
                  }}
                />
              </div>
              <div className="flex-1 min-w-[120px]">
                <label className="text-xs text-muted-foreground">密码</label>
                <div className="flex items-center gap-1">
                  <Input
                    type={revealedPasswords[i] ? 'text' : 'password'}
                    value={a.password}
                    onChange={(e) => {
                      const next = [...config.accounts];
                      next[i] = { ...next[i], password: e.target.value };
                      update(['accounts'], next);
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() =>
                      setRevealedPasswords((prev) => ({ ...prev, [i]: !prev[i] }))
                    }
                  >
                    {revealedPasswords[i] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => update(['accounts'], config.accounts.filter((_, j) => j !== i))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              update(['accounts'], [
                ...config.accounts,
                { email: '', mobile: '', area_code: '', password: '' },
              ])
            }
          >
            <Plus className="h-4 w-4 mr-1" /> 添加账号
          </Button>
        </CardContent>
      </Card>

      {/* ── API Keys (always visible) ─────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Key className="h-5 w-5" /> API Keys
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {config.api_keys.map((k, i) => (
            <div key={k.key} className="flex items-center gap-2 p-2 border rounded-md">
              {/* Show/hide toggle */}
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() =>
                  setRevealedKeys((prev) => ({ ...prev, [i]: !prev[i] }))
                }
              >
                {revealedKeys[i] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              {/* Key value */}
              <Input
                type={revealedKeys[i] ? 'text' : 'password'}
                value={k.key}
                onChange={(e) => {
                  const next = [...config.api_keys];
                  next[i] = { ...next[i], key: e.target.value };
                  update(['api_keys'], next);
                }}
                className="flex-1 font-mono text-xs"
              />
              {/* Copy */}
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => copyToClipboard(k.key)}
                title="复制"
              >
                <Copy className="h-4 w-4" />
              </Button>
              {/* Description */}
              <input
                className="flex-1 min-w-[80px] bg-transparent border-b border-dashed border-muted-foreground/30 text-sm px-1 outline-none focus:border-primary"
                value={k.description}
                placeholder="描述"
                onChange={(e) => {
                  const next = [...config.api_keys];
                  next[i] = { ...next[i], description: e.target.value };
                  update(['api_keys'], next);
                }}
              />
              {/* Delete */}
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => update(['api_keys'], config.api_keys.filter((_, j) => j !== i))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const newKey = generateApiKey();
              update(['api_keys'], [
                ...config.api_keys,
                { key: newKey, description: '' },
              ]);
            }}
          >
            <Plus className="h-4 w-4 mr-1" /> 添加 API Key
          </Button>
        </CardContent>
      </Card>


      {/* ── Admin (collapsible) ────────────────────────────── */}
      <Section title="Admin" icon={Shield}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant={config.admin.password_set ? 'default' : 'secondary'}>
              {config.admin.password_set ? '密码已设置' : '密码未设置'}
            </Badge>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-muted-foreground block mb-1">旧密码</label>
              <Input
                type="password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="输入旧密码以修改"
              />
            </div>
            <div>
              <label className="text-sm text-muted-foreground block mb-1">新密码</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="至少 6 位"
              />
            </div>
          </div>
        </div>
      </Section>
      <Separator className="my-2" />

      {/* ── Server (collapsible) ──────────────────────────────── */}
      <Section title="服务器" icon={Server}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="text-sm text-muted-foreground block mb-1">监听地址</label>
            <Input value={config.server.host} onChange={(e) => update(['server', 'host'], e.target.value)} />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">端口</label>
            <Input
              type="number"
              value={config.server.port}
              onChange={(e) => update(['server', 'port'], Number(e.target.value))}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">CORS 来源（逗号分隔）</label>
            <Input
              value={config.server.cors_origins.join(', ')}
              onChange={(e) =>
                update(
                  ['server', 'cors_origins'],
                  e.target.value.split(/,\s*/).filter(Boolean),
                )
              }
            />
          </div>
        </div>
      </Section>

      {/* ── DeepSeek (collapsible) ────────────────────────────── */}
      <Section title="DeepSeek" icon={Cpu}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-muted-foreground block mb-1">API Base</label>
            <Input
              value={config.deepseek.api_base}
              onChange={(e) => update(['deepseek', 'api_base'], e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">WASM URL</label>
            <Input
              value={config.deepseek.wasm_url}
              onChange={(e) => update(['deepseek', 'wasm_url'], e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">User-Agent</label>
            <Input
              value={config.deepseek.user_agent}
              onChange={(e) => update(['deepseek', 'user_agent'], e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Client Version</label>
            <Input
              value={config.deepseek.client_version}
              onChange={(e) => update(['deepseek', 'client_version'], e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Client Platform</label>
            <Input
              value={config.deepseek.client_platform}
              onChange={(e) => update(['deepseek', 'client_platform'], e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Client Locale</label>
            <Input
              value={config.deepseek.client_locale}
              onChange={(e) => update(['deepseek', 'client_locale'], e.target.value)}
            />
          </div>
        </div>
      </Section>

      {/* ── Models (collapsible) ──────────────────────────────── */}
      <Section title="模型类型" icon={Globe}>
        <div className="space-y-3">
          {config.deepseek.model_types.map((_, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 p-3 border rounded-md">
              <div className="flex-1 min-w-[120px]">
                <label className="text-xs text-muted-foreground">类型名</label>
                <Input
                  value={config.deepseek.model_types[i]}
                  onChange={(e) => {
                    const next = [...config.deepseek.model_types];
                    next[i] = e.target.value;
                    update(['deepseek', 'model_types'], next);
                  }}
                />
              </div>
              <div className="w-20">
                <label className="text-xs text-muted-foreground">最大输入</label>
                <Input
                  type="number"
                  value={config.deepseek.max_input_tokens[i]}
                  onChange={(e) => {
                    const next = [...config.deepseek.max_input_tokens];
                    next[i] = Number(e.target.value);
                    update(['deepseek', 'max_input_tokens'], next);
                  }}
                />
              </div>
              <div className="w-20">
                <label className="text-xs text-muted-foreground">最大输出</label>
                <Input
                  type="number"
                  value={config.deepseek.max_output_tokens[i]}
                  onChange={(e) => {
                    const next = [...config.deepseek.max_output_tokens];
                    next[i] = Number(e.target.value);
                    update(['deepseek', 'max_output_tokens'], next);
                  }}
                />
              </div>
              <div className="flex-1 min-w-[120px]">
                <label className="text-xs text-muted-foreground">别名（可选）</label>
                <Input
                  value={config.deepseek.model_aliases[i] || ''}
                  onChange={(e) => {
                    const next = [...config.deepseek.model_aliases];
                    next[i] = e.target.value;
                    update(['deepseek', 'model_aliases'], next);
                  }}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={() => {
                  update(['deepseek', 'model_types'], config.deepseek.model_types.filter((_, j) => j !== i));
                  update(['deepseek', 'max_input_tokens'], config.deepseek.max_input_tokens.filter((_, j) => j !== i));
                  update(
                    ['deepseek', 'max_output_tokens'],
                    config.deepseek.max_output_tokens.filter((_, j) => j !== i),
                  );
                  update(['deepseek', 'model_aliases'], config.deepseek.model_aliases.filter((_, j) => j !== i));
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              update(['deepseek', 'model_types'], [...config.deepseek.model_types, 'new']);
              update(['deepseek', 'max_input_tokens'], [...config.deepseek.max_input_tokens, 32000]);
              update(['deepseek', 'max_output_tokens'], [...config.deepseek.max_output_tokens, 8000]);
              update(['deepseek', 'model_aliases'], [...config.deepseek.model_aliases, '']);
            }}
          >
            <Plus className="h-4 w-4 mr-1" /> 添加模型类型
          </Button>
        </div>
      </Section>

      {/* ── Tool Call Tags (collapsible) ──────────────────────── */}
      <Section title="工具调用标签" icon={Tags}>
        <div className="space-y-4">
          <div>
            <label className="text-sm text-muted-foreground block mb-1">额外开始标签</label>
            <div className="flex flex-wrap gap-2">
              {config.deepseek.tool_call.extra_starts.map((tag, i) => (
                <Badge key={i} variant="secondary" className="gap-1">
                  {tag}
                  <button
                    onClick={() => {
                      const next = config.deepseek.tool_call.extra_starts.filter((_, j) => j !== i);
                      update(['deepseek', 'tool_call', 'extra_starts'], next);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <Input
                className="w-48 h-8 text-xs"
                placeholder="新标签，回车添加"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                    update(['deepseek', 'tool_call', 'extra_starts'], [
                      ...config.deepseek.tool_call.extra_starts,
                      e.currentTarget.value.trim(),
                    ]);
                    e.currentTarget.value = '';
                  }
                }}
              />
            </div>
          </div>
          <div>
            <label className="text-sm text-muted-foreground block mb-1">额外结束标签</label>
            <div className="flex flex-wrap gap-2">
              {config.deepseek.tool_call.extra_ends.map((tag, i) => (
                <Badge key={i} variant="secondary" className="gap-1">
                  {tag}
                  <button
                    onClick={() => {
                      const next = config.deepseek.tool_call.extra_ends.filter((_, j) => j !== i);
                      update(['deepseek', 'tool_call', 'extra_ends'], next);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <Input
                className="w-48 h-8 text-xs"
                placeholder="新标签，回车添加"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                    update(['deepseek', 'tool_call', 'extra_ends'], [
                      ...config.deepseek.tool_call.extra_ends,
                      e.currentTarget.value.trim(),
                    ]);
                    e.currentTarget.value = '';
                  }
                }}
              />
            </div>
          </div>
        </div>
      </Section>

      {/* ── Proxy (collapsible) ───────────────────────────────── */}
      <Section title="代理" icon={Globe}>
        <div>
          <label className="text-sm text-muted-foreground block mb-1">代理 URL（留空禁用）</label>
          <Input
            value={config.proxy.url || ''}
            placeholder="http://127.0.0.1:7890"
            onChange={(e) => update(['proxy', 'url'], e.target.value || null)}
          />
        </div>
      </Section>

      <Separator className="my-2" />

      {/* ── Action buttons ────────────────────────────────────── */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={handleCancel} disabled={saving}>
          取消
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-5 w-5 mr-2" />
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </div>
    </div>
  );
}
