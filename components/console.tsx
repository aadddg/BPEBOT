"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  LayoutDashboard,
  Menu,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { previewCommand, type Command } from "@/lib/commands";
import type { BotCommand, BotLog, ConsoleState, Policy } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
  EmptyContent,
} from "@/components/ui/empty";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";

const navigation = [
  {
    href: "/dashboard",
    label: "运行概览",
    icon: LayoutDashboard,
    group: "运行",
  },
  {
    href: "/dashboard/commands",
    label: "指令管理",
    icon: Terminal,
    group: "运行",
  },
  { href: "/dashboard/logs", label: "消息日志", icon: Activity, group: "运行" },
  {
    href: "/dashboard/approval",
    label: "入群审批",
    icon: ShieldCheck,
    group: "配置",
  },
  {
    href: "/dashboard/webhook",
    label: "Webhook 状态",
    icon: Webhook,
    group: "系统",
  },
  {
    href: "/dashboard/settings",
    label: "系统设置",
    icon: Settings2,
    group: "系统",
  },
];
const matchNames = {
  exact: "完全匹配",
  prefix: "前缀匹配",
  contains: "包含关键词",
};
const roleNames = {
  any: "所有成员",
  group_admin: "群管理员",
  platform_admin: "平台管理员",
};
const statusNames: Record<string, string> = {
  replied: "已回复",
  success: "成功",
  failed: "失败",
  denied: "权限不足",
  miss: "未命中",
  missed: "未命中",
  ignored: "已忽略",
  pending: "处理中",
  unsupported: "待联调",
  processing: "处理中",
  approved: "已通过",
  rejected: "已拒绝",
};
const when = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" })
    : "暂无记录";
const short = (value?: string | null) =>
  value
    ? value.length > 15
      ? `${value.slice(0, 8)}…${value.slice(-4)}`
      : value
    : "—";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/admin/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) window.location.assign("/login");
    throw new Error(result.error || "操作失败，请稍后重试。");
  }
  return result;
}
function Dropdown({
  label,
  value,
  items,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(v) => v && onChange(v)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
function Blank({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <Empty className="min-h-52">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ArrowDownLeft />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
function Status({ value }: { value: string }) {
  return (
    <Badge variant="secondary">
      <span
        className={cn(
          "status-dot mr-1",
          ["replied", "success", "approved"].includes(value)
            ? "text-success"
            : ["failed", "denied", "rejected"].includes(value)
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      />
      {statusNames[value] || value}
    </Badge>
  );
}
export function Console({ userName = "管理员", sso = false }: { userName?: string; sso?: boolean }) {
  const path = usePathname();
  const [data, setData] = useState<ConsoleState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mobile, setMobile] = useState(false);
  const current =
    navigation.find((item) => item.href === path) || navigation[0];
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api("state"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutate = async (resource: string, method: string, body?: unknown) => {
    await api(resource, method, body);
    toast.add({ title: "更改已保存", type: "success" });
    await refresh();
  };
  const nav = (
    <>
      <Link
        href="/dashboard"
        onClick={() => setMobile(false)}
        className="flex h-16 items-center gap-3 px-6"
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bot className="size-5" />
        </span>
        <span className="font-semibold tracking-tight">
          BPE BOT{" "}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            控制台
          </span>
        </span>
      </Link>
      <div className="px-3 py-5">
        {["运行", "配置", "系统"].map((group) => (
          <div key={group} className="mb-7">
            <p className="mb-2 px-3 text-[11px] tracking-widest text-muted-foreground">
              {group}
            </p>
            <nav aria-label={group} className="flex flex-col gap-1">
              {navigation
                .filter((item) => item.group === group)
                .map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobile(false)}
                    className={cn(
                      "flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors hover:bg-accent",
                      path === item.href
                        ? "bg-secondary font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                    aria-current={path === item.href ? "page" : undefined}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                    {path === item.href && (
                      <ChevronRight className="ml-auto size-3 text-muted-foreground" />
                    )}
                  </Link>
                ))}
            </nav>
          </div>
        ))}
      </div>
      <div className="mt-auto px-6 pb-5">
        <Separator className="mb-4" />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="status-dot" />
          V0.1 · 单实例
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          BreezeverPlatform Evolution
        </p>
      </div>
    </>
  );
  return (
    <div className="min-h-dvh">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r bg-card md:flex">
        {nav}
      </aside>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetContent side="left" className="flex w-64 flex-col p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>导航菜单</SheetTitle>
            <SheetDescription>选择管理页面</SheetDescription>
          </SheetHeader>
          {nav}
        </SheetContent>
      </Sheet>
      <div className="md:ml-60">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur-sm md:px-6">
          <Button
            variant="ghost"
            size="icon"
            aria-label="打开导航"
            className="md:hidden"
            onClick={() => setMobile(true)}
          >
            <Menu />
          </Button>
          <span className="text-xs text-muted-foreground">工作空间</span>
          <ChevronRight className="size-3 text-muted-foreground" />
          <span className="text-xs">{current.label}</span>
          <div className="ml-auto flex items-center gap-3">
            <Badge variant="outline">管理员</Badge>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {userName}
            </span>
            {sso && <form action="/api/sso/logout" method="post"><Button type="submit" variant="ghost" size="sm">退出登录</Button></form>}
          </div>
        </header>
        <main className="mx-auto max-w-6xl p-4 pb-12 md:p-6 lg:p-8">
          <div className="mb-7 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <current.icon className="size-3.5" />
                <span>BOT / {current.group}</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {current.label}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {path.endsWith("commands")
                  ? "让每条指令都按预期生效。"
                  : path.endsWith("logs")
                    ? "从一条消息，追踪完整的处理过程。"
                    : path.endsWith("approval")
                      ? "配置新成员进入群聊的条件。"
                      : path.endsWith("webhook")
                        ? "检查事件是否送达，以及每一次处理的结果。"
                        : path.endsWith("settings")
                          ? "检查连接配置与运行环境。"
                          : "先看需要处理的事，再了解今天的运行情况。"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw
                data-icon="inline-start"
                className={cn(loading && "animate-spin")}
              />
              刷新
            </Button>
          </div>
          {error && (
            <Alert variant="destructive" className="mb-5">
              <CircleHelp />
              <AlertTitle>暂时无法读取运行数据</AlertTitle>
              <AlertDescription>
                {error}。请检查平台连接、数据库配置与 Schema 版本。
              </AlertDescription>
            </Alert>
          )}
          {!data && loading ? (
            <div className="flex flex-col gap-4" aria-label="正在加载">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-60 w-full" />
            </div>
          ) : data ? (
            <div
              className={cn("page-enter", loading && "opacity-60")}
              aria-busy={loading}
            >
              {path.endsWith("commands") ? (
                <Commands data={data} mutate={mutate} />
              ) : path.endsWith("logs") ? (
                <Logs data={data} />
              ) : path.endsWith("approval") ? (
                <Approval data={data} mutate={mutate} />
              ) : path.endsWith("webhook") ? (
                <WebhookPage data={data} />
              ) : path.endsWith("settings") ? (
                <SettingsPage data={data} mutate={mutate} />
              ) : (
                <Overview data={data} />
              )}
            </div>
          ) : (
            !error && (
              <Blank
                title="等待连接"
                description="完成配置后将在这里显示真实运行数据。"
              />
            )
          )}
        </main>
        <footer className="flex justify-between px-6 pb-5 text-[11px] text-muted-foreground">
          <span>BPE BOT · 为群聊提供有序的连接</span>
          <span>V0.1.0</span>
        </footer>
      </div>
    </div>
  );
}

function Overview({ data }: { data: ConsoleState }) {
  const missing = Object.entries(data.settings.configured || {}).filter(
    ([, configured]) => !configured,
  );
  const failures = data.logs.filter((log) => log.reply_status === "failed");
  const invalid = data.requests.filter((request) => !request.signature_valid && request.processing_result !== 'handshake_unsigned');
  const attention =
    Number(missing.length > 0) +
    Number(failures.length > 0) +
    Number(invalid.length > 0);
  const today = data.logs.filter(
    (log) =>
      new Date(log.created_at).toLocaleDateString("zh-CN", {
        timeZone: "Asia/Shanghai",
      }) ===
      new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }),
  );
  const groups = Object.entries(
    data.logs.reduce<Record<string, number>>((all, log) => {
      if (log.group_openid)
        all[log.group_openid] = (all[log.group_openid] || 0) + 1;
      return all;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);
  return (
    <div className="flex flex-col gap-6">
      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border p-5",
          attention
            ? "border-warning/20 bg-warning-soft"
            : "border-border bg-card",
        )}
      >
        <span
          className={cn(
            "mt-1 flex size-8 shrink-0 items-center justify-center rounded-full",
            attention
              ? "bg-warning/10 text-warning"
              : "bg-success-soft text-success",
          )}
        >
          {attention ? (
            <CircleHelp className="size-4" />
          ) : (
            <Check className="size-4" />
          )}
        </span>
        <div>
          <h2 className="font-medium">
            {attention
              ? `${attention} 项内容需要你的关注`
              : data.requests.length
                ? "运行正常，暂无需要处理的事项"
                : "配置就绪，等待首条事件"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {attention
              ? "按下方提示检查配置与运行记录。"
              : "接收 QQ 群聊事件后，运行情况会在这里呈现。"}
          </p>
        </div>
        <Badge className="ml-auto hidden sm:inline-flex" variant="outline">
          运行状态
        </Badge>
      </div>
      {attention > 0 && (
        <div className="overflow-hidden rounded-xl border bg-card">
          {[
            {
              show: missing.length > 0,
              title: "完成运行环境配置",
              description: `${missing.map(([key]) => key).join("、")} 尚未配置`,
              href: "/dashboard/settings",
            },
            {
              show: failures.length > 0,
              title: `${failures.length} 条消息处理失败`,
              description: "打开日志查看失败原因和触发指令。",
              href: "/dashboard/logs?status=failed",
            },
            {
              show: invalid.length > 0,
              title: "检测到签名校验失败",
              description: "检查 QQ 密钥、请求签名与原始请求体。",
              href: "/dashboard/webhook",
            },
          ]
            .filter((item) => item.show)
            .map((item, i) => (
              <div
                key={item.title}
                className={cn(
                  "flex items-center gap-4 p-4",
                  i > 0 && "border-t",
                )}
              >
                <span className="text-warning">
                  <CircleHelp className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{item.title}</p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </div>
                <Link
                  href={item.href}
                  className="flex shrink-0 items-center gap-1 text-xs font-medium"
                >
                  去处理
                  <ArrowRight className="size-3" />
                </Link>
              </div>
            ))}
        </div>
      )}
      <section className="py-2">
        <p className="mb-3 text-xs text-muted-foreground">
          今天 · 上海时间 · 当前加载的最近记录
        </p>
        <p className="max-w-3xl text-lg leading-8 text-muted-foreground">
          共接收{" "}
          <strong className="font-semibold text-foreground">
            {today.length}
          </strong>{" "}
          条事件，
          <strong className="font-semibold text-foreground">
            {today.filter((log) => log.matched_command_id).length}
          </strong>{" "}
          次指令命中，
          <strong className="font-semibold text-foreground">
            {today.filter((log) => log.reply_status === "failed").length}
          </strong>{" "}
          次处理失败。
          <br />有{" "}
          <strong className="font-semibold text-foreground">
            {today.filter((log) => log.action_type === "approval").length}
          </strong>{" "}
          次审批记录，
          <strong className="font-semibold text-foreground">
            {
              today.filter((log) =>
                ["moderation", "warn", "ban"].includes(log.action_type || ""),
              ).length
            }
          </strong>{" "}
          次群管理操作。
        </p>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle>群聊活跃度</CardTitle>
            <CardDescription>最近记录中的消息分布</CardDescription>
          </CardHeader>
          <CardContent>
            {!groups.length ? (
              <Blank
                title="尚未收到群消息"
                description="群聊开始互动后，活跃度将在这里呈现。"
              />
            ) : (
              <div className="flex flex-col gap-5 py-3">
                {groups.map(([group, count]) => (
                  <div key={group}>
                    <div className="mb-2 flex justify-between text-xs">
                      <span title={group}>{short(group)}</span>
                      <span className="text-muted-foreground">{count} 条</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${(count / groups[0][1]) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>最近事件</CardTitle>
            <CardDescription>每一次交互，都有迹可循</CardDescription>
          </CardHeader>
          <CardContent>
            {!data.logs.length ? (
              <Blank
                title="时间线还是空的"
                description="指令命中、入群审批和系统异常将汇集在这里。"
              />
            ) : (
              <div className="flex flex-col">
                {data.logs.slice(0, 6).map((log) => (
                  <Link
                    key={log.id}
                    href={`/dashboard/logs?event_id=${encodeURIComponent(log.event_id)}`}
                    className="flex gap-3 border-b py-3 last:border-0"
                  >
                    <span
                      className={cn(
                        "status-dot mt-1.5 shrink-0",
                        log.reply_status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs">
                        {log.content || log.event_type}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {when(log.created_at)}
                      </p>
                    </div>
                    <Status value={log.reply_status} />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const newCommand = (): Command => ({
  id: crypto.randomUUID(),
  keyword: "",
  match_type: "exact",
  reply_type: "text",
  reply_body: "",
  priority: 0,
  enabled: true,
  min_role: "any",
  builtin: false,
  builtin_key: null,
});
const commandInput = (command: Command): Command => ({
  id: command.id,
  keyword: command.keyword,
  match_type: command.match_type,
  reply_type: command.reply_type,
  reply_body: command.reply_body,
  priority: command.priority,
  enabled: command.enabled,
  min_role: command.min_role,
  builtin: command.builtin,
  builtin_key: command.builtin_key,
});
function Commands({
  data,
  mutate,
}: {
  data: ConsoleState;
  mutate: (path: string, method: string, body?: unknown) => Promise<void>;
}) {
  const query = useSearchParams();
  const [draft, setDraft] = useState<Command | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState("");
  const [deleting, setDeleting] = useState<Command | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const commands = [...data.commands].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const edit = (command?: Command) => {
    setDraft(command ? commandInput(command) : newCommand());
    setIsNew(!command);
    setTest(command?.keyword || "/help");
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await mutate(
        isNew ? "commands" : `commands/${draft.id}`,
        isNew ? "POST" : "PATCH",
        draft,
      );
      setDraft(null);
    } catch (e) {
      toast.add({ title: (e as Error).message, type: "error" });
    } finally {
      setBusy(false);
    }
  };
  const card = (command: BotCommand) => (
    <Card
      size="sm"
      key={command.id}
      id={command.id}
      className={cn(query.get("command") === command.id && "ring-2 ring-ring")}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{command.keyword}</CardTitle>
          <Badge variant="outline">{matchNames[command.match_type]}</Badge>
          <Badge variant="secondary">
            {command.builtin
              ? "群管理"
              : command.reply_type === "markdown"
                ? "Markdown"
                : "文本回复"}
          </Badge>
          <div className="ml-auto flex items-center gap-3">
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                !command.enabled
                  ? "text-muted-foreground"
                  : (command.hits || []).some(Boolean)
                    ? "text-success"
                    : "text-warning",
              )}
            >
              <span className="status-dot" />
              {!command.enabled
                ? "已停用"
                : (command.hits || []).some(Boolean)
                  ? "活跃"
                  : "尚未触发"}
            </span>
            <Switch
              checked={command.enabled}
              aria-label={`启用 ${command.keyword}`}
              disabled={busy}
              onCheckedChange={async (checked) => {
                setBusy(true);
                try {
                  const value = commandInput(command);
                  await mutate(`commands/${command.id}`, "PATCH", {
                    ...value,
                    enabled: checked,
                  });
                } catch (e) {
                  toast.add({ title: (e as Error).message, type: "error" });
                } finally {
                  setBusy(false);
                }
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => edit(command)}>
              编辑
            </Button>
          </div>
        </div>
        <CardDescription>
          <span className="line-clamp-2 whitespace-pre-wrap">
            {command.reply_body}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <div
            className="flex h-5 items-end gap-1"
            aria-label="最近七天命中趋势"
          >
            {(command.hits || [0, 0, 0, 0, 0, 0, 0]).map((count, i, hits) => (
              <span
                key={i}
                title={`${count} 次`}
                className={cn(
                  "w-1 rounded-sm",
                  count ? "bg-primary" : "bg-border",
                )}
                style={{
                  height: `${Math.max(3, (count / Math.max(1, ...hits)) * 20)}px`,
                }}
              />
            ))}
          </div>
          <span>
            7 天 · {(command.hits || []).reduce((a, b) => a + b, 0)} 次命中
          </span>
          <span className="hidden sm:inline">·</span>
          <span>{roleNames[command.min_role]}</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => {
              setExpanded(expanded === command.id ? null : command.id);
              setTest(command.keyword);
            }}
          >
            测试一下
            <Terminal data-icon="inline-end" />
          </Button>
        </div>
        {command.recent?.slice(0, 2).map((log) => (
          <Link
            key={log.id}
            href={`/dashboard/logs?event_id=${encodeURIComponent(log.event_id)}`}
            className="mt-2 block truncate text-xs text-muted-foreground hover:text-foreground"
          >
            最近命中 · {when(log.created_at)} · {log.content}
          </Link>
        ))}
        {expanded === command.id && (
          <div className="mt-4 flex flex-col gap-3 border-t pt-4">
            <Field>
              <FieldLabel htmlFor={`test-${command.id}`}>模拟消息</FieldLabel>
              <Input
                id={`test-${command.id}`}
                value={test}
                onChange={(e) => setTest(e.target.value)}
              />
            </Field>
            <Preview commands={commands} draft={command} message={test} />
          </div>
        )}
      </CardContent>
    </Card>
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {commands.length} 条指令 <span className="mx-2">/</span>
          {commands.filter((item) => item.enabled).length} 条已启用
        </p>
        <Button onClick={() => edit()}>
          <Plus data-icon="inline-start" />
          新建指令
        </Button>
      </div>
      {commands.filter((item) => !item.builtin).map(card)}
      {!commands.some((item) => !item.builtin) && (
        <div className="rounded-xl border bg-card">
          <Blank
            title="创建第一条指令"
            description="从 /help 开始，为群成员提供一条清晰的使用指引。"
          >
            <Button
              variant="outline"
              onClick={() => {
                edit();
                setDraft({
                  ...newCommand(),
                  keyword: "/help",
                  reply_body:
                    "你好！欢迎使用 BPE BOT。请联系群管理员了解可用指令。",
                });
              }}
            >
              使用 /help 模板
              <ArrowRight data-icon="inline-end" />
            </Button>
          </Blank>
        </div>
      )}
      <div className="mt-3">
        <h2 className="mb-2 text-sm font-semibold">内置群管理指令</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          仅群管理员可执行。官方接口与目标群权限联调通过后开放执行。
        </p>
        <div className="flex flex-col gap-4">
          {commands.filter((item) => item.builtin).map(card)}
        </div>
      </div>
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open && !busy) setDraft(null);
        }}
      >
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {isNew ? "新建指令" : `编辑 ${draft?.keyword}`}
            </DialogTitle>
            <DialogDescription>
              设置回复内容，并在保存前检查匹配结果。
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="flex flex-col gap-5"
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="keyword">关键词</FieldLabel>
                  <Input
                    id="keyword"
                    value={draft.keyword}
                    disabled={draft.builtin || busy}
                    maxLength={200}
                    placeholder="例如 /help"
                    onChange={(e) =>
                      setDraft({ ...draft, keyword: e.target.value })
                    }
                  />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel>匹配方式</FieldLabel>
                    <Dropdown
                      label="匹配方式"
                      value={draft.match_type}
                      disabled={draft.builtin || busy}
                      items={Object.entries(matchNames).map(
                        ([value, label]) => ({ value, label }),
                      )}
                      onChange={(value) =>
                        setDraft({
                          ...draft,
                          match_type: value as Command["match_type"],
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="priority">优先级</FieldLabel>
                    <Input
                      id="priority"
                      type="number"
                      min={-1000000}
                      max={1000000}
                      disabled={draft.builtin || busy}
                      value={draft.priority}
                      onChange={(e) =>
                        setDraft({ ...draft, priority: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel>回复类型</FieldLabel>
                    <Dropdown
                      label="回复类型"
                      value={draft.reply_type}
                      disabled={draft.builtin || busy}
                      items={[
                        { value: "text", label: "文本" },
                        { value: "markdown", label: "Markdown" },
                      ]}
                      onChange={(value) =>
                        setDraft({
                          ...draft,
                          reply_type: value as Command["reply_type"],
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>最低权限</FieldLabel>
                    <Dropdown
                      label="最低权限"
                      value={draft.min_role}
                      disabled={draft.builtin || busy}
                      items={Object.entries(roleNames).map(
                        ([value, label]) => ({ value, label }),
                      )}
                      onChange={(value) =>
                        setDraft({
                          ...draft,
                          min_role: value as Command["min_role"],
                        })
                      }
                    />
                  </Field>
                </div>
                <Field>
                  <FieldLabel htmlFor="reply">
                    {draft.builtin_key === "warn"
                      ? "警告模板 · 支持 {target}、{reason}、{operator}"
                      : "回复内容"}
                  </FieldLabel>
                  <Textarea
                    id="reply"
                    value={draft.reply_body}
                    maxLength={10000}
                    rows={4}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, reply_body: e.target.value })
                    }
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="enabled">启用此指令</FieldLabel>
                  <Switch
                    id="enabled"
                    checked={draft.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setDraft({ ...draft, enabled: checked })
                    }
                  />
                </Field>
                <Separator />
                <Field>
                  <FieldLabel htmlFor="preview-message">保存前测试</FieldLabel>
                  <Input
                    id="preview-message"
                    value={test}
                    onChange={(e) => setTest(e.target.value)}
                    placeholder="输入一条模拟消息"
                  />
                </Field>
                <Preview commands={commands} draft={draft} message={test} />
              </FieldGroup>
              <DialogFooter>
                {!isNew && !draft.builtin && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="mr-auto"
                    disabled={busy}
                    onClick={() => setDeleting(draft)}
                  >
                    <Trash2 data-icon="inline-start" />
                    删除
                  </Button>
                )}
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    busy || !draft.keyword.trim() || !draft.reply_body.trim()
                  }
                >
                  {busy ? "保存中…" : "保存指令"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Confirm
        open={!!deleting}
        busy={busy}
        title={`删除 ${deleting?.keyword}？`}
        description="删除后，该指令将不再响应群消息。已有运行日志会保留。"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          setBusy(true);
          try {
            await mutate(`commands/${deleting.id}`, "DELETE");
            setDeleting(null);
            setDraft(null);
          } catch (e) {
            toast.add({ title: (e as Error).message, type: "error" });
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
function Preview({
  commands,
  draft,
  message,
}: {
  commands: Command[];
  draft: Command;
  message: string;
}) {
  const preview = previewCommand(commands, draft, message);
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border p-3 text-xs",
        preview.state === "matched"
          ? "border-success/20 bg-success-soft"
          : preview.state === "captured"
            ? "border-warning/20 bg-warning-soft"
            : "bg-muted/50",
      )}
    >
      <p className="font-medium">
        {preview.state === "matched"
          ? "命中此指令"
          : preview.state === "captured"
            ? `被 ${preview.command.keyword} 优先匹配`
            : "未匹配任何指令"}
      </p>
      {preview.command && (
        <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
          {preview.command.reply_body || "尚未填写回复内容"}
        </p>
      )}
      {draft.builtin && (
        <p className="mt-2 text-muted-foreground">
          实际执行还需验证群管理员身份、目标成员权限与接口可用性。
        </p>
      )}
    </div>
  );
}
function Confirm({
  open,
  busy,
  title,
  description,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  busy: boolean;
  title: string;
  description: string;
  onConfirm: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => !value && !busy && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? "处理中…" : "确认操作"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Logs({ data }: { data: ConsoleState }) {
  const router = useRouter(),
    query = useSearchParams();
  const [selected, setSelected] = useState<BotLog | null>(null);
  const [records, setRecords] = useState<BotLog[]>([]);
  const [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const status = query.get("status") || "",
    group = query.get("group") || "",
    action = query.get("action") || "",
    type = query.get("type") || "",
    event = query.get("event_id") || "";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const [groupInput, setGroupInput] = useState(group);
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(query.toString());
    value ? next.set(key, value) : next.delete(key);
    if (key !== "page") next.delete("page");
    router.replace(`/dashboard/logs?${next}`);
  };
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), limit: "20" });
    for (const [key, value] of Object.entries({
      reply_status: status,
      group_openid: group,
      action_type: action,
      event_type: type,
      event_id: event,
    }))
      if (value) params.set(key, value);
    setLoading(true);
    fetch(`/api/admin/logs?${params}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "日志读取失败");
        return value;
      })
      .then((value) => {
        setRecords(value.logs);
        setTotal(value.total);
        setError("");
        if (event && value.logs[0]) setSelected(value.logs[0]);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, status, group, action, type, event, data]);
  const filtered = !!(status || group || action || type || event);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-auto">
          <FieldLabel>回复状态</FieldLabel>
          <Dropdown
            label="回复状态"
            value={status || "all"}
            items={[
              { value: "all", label: "全部状态" },
              ...[
                "replied",
                "failed",
                "denied",
                "miss",
                "unsupported",
                "processing",
              ].map((value) => ({ value, label: statusNames[value] })),
            ]}
            onChange={(value) => update("status", value === "all" ? "" : value)}
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel>操作类型</FieldLabel>
          <Dropdown
            label="操作类型"
            value={action || "all"}
            items={[
              { value: "all", label: "全部操作" },
              { value: "message", label: "消息" },
              { value: "approval", label: "审批" },
              { value: "moderation", label: "群管理" },
            ]}
            onChange={(value) => update("action", value === "all" ? "" : value)}
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="group-filter">群 OpenID</FieldLabel>
          <Input
            id="group-filter"
            placeholder="输入后按回车"
            value={groupInput}
            onChange={(e) => setGroupInput(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && update("group", groupInput.trim())
            }
            onBlur={() =>
              groupInput.trim() !== group && update("group", groupInput.trim())
            }
          />
        </Field>
        <Field className="w-auto">
          <FieldLabel htmlFor="event-filter">事件类型</FieldLabel>
          <Input
            id="event-filter"
            placeholder="全部事件"
            defaultValue={type}
            onKeyDown={(e) =>
              e.key === "Enter" && update("type", e.currentTarget.value.trim())
            }
            onBlur={(e) =>
              e.currentTarget.value.trim() !== type &&
              update("type", e.currentTarget.value.trim())
            }
          />
        </Field>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setGroupInput("");
              router.replace("/dashboard/logs");
            }}
          >
            <X data-icon="inline-start" />
            清除筛选
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>日志读取失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div
        className={cn(
          "overflow-hidden rounded-xl border bg-card",
          loading && "opacity-60",
        )}
        aria-busy={loading}
      >
        {records.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>事件 / 群</TableHead>
                <TableHead>发送者</TableHead>
                <TableHead>内容摘要</TableHead>
                <TableHead>命中指令</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {when(log.created_at)}
                  </TableCell>
                  <TableCell>
                    <p className="max-w-40 truncate text-xs">
                      {log.event_type}
                    </p>
                    <p
                      className="mt-1 text-[11px] text-muted-foreground"
                      title={log.group_openid || ""}
                    >
                      {short(log.group_openid)}
                    </p>
                  </TableCell>
                  <TableCell
                    className="text-xs"
                    title={log.member_openid || ""}
                  >
                    {short(log.member_openid)}
                  </TableCell>
                  <TableCell className="max-w-48 truncate text-xs">
                    {log.content || "—"}
                  </TableCell>
                  <TableCell>
                    {log.matched_command_id ? (
                      <Link
                        href={`/dashboard/commands?command=${encodeURIComponent(log.matched_command_id)}`}
                        className="text-xs underline underline-offset-4"
                      >
                        {data.commands.find(
                          (command) => command.id === log.matched_command_id,
                        )?.keyword || "已删除的指令"}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Status value={log.reply_status} />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(log)}
                    >
                      查看
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Blank
            title={
              loading
                ? "正在读取日志"
                : filtered
                  ? "没有符合筛选条件的记录"
                  : "还没有运行日志"
            }
            description={
              filtered
                ? "调整筛选条件，或清除筛选以查看全部记录。"
                : "机器人接收消息后，处理记录将显示在这里。"
            }
          />
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>共 {total} 条 · 每页 20 条</span>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || loading}
            onClick={() => update("page", String(page - 1))}
          >
            上一页
          </Button>
          <span>第 {page} 页</span>
          <Button
            variant="outline"
            size="sm"
            disabled={page * 20 >= total || loading}
            onClick={() => update("page", String(page + 1))}
          >
            下一页
          </Button>
        </div>
      </div>
      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>事件详情</SheetTitle>
            <SheetDescription>完整消息与处理结果</SheetDescription>
          </SheetHeader>
          {selected && (
            <div className="flex flex-col gap-6 p-4">
              <Status value={selected.reply_status} />
              <dl className="flex flex-col gap-3">
                {[
                  ["事件 ID", selected.event_id],
                  ["时间", when(selected.created_at)],
                  ["类型", selected.event_type],
                  ["群 OpenID", selected.group_openid],
                  ["成员 OpenID", selected.member_openid],
                  ["msg_id", selected.msg_id],
                  ["member_role", selected.member_role],
                  ["操作类型", selected.action_type],
                  ["目标 OpenID", selected.target_openid],
                  ["操作人 OpenID", selected.operator_openid],
                ].map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-[110px_1fr] gap-3 text-xs"
                  >
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="break-all">{value || "—"}</dd>
                  </div>
                ))}
              </dl>
              <Separator />
              {[
                ["完整内容", selected.content],
                ["回复内容", selected.reply_body],
                ["失败原因", selected.error],
              ].map(([label, value]) => (
                <section key={label}>
                  <h3 className="mb-2 text-xs font-medium">{label}</h3>
                  <p className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs leading-6">
                    {value || "无"}
                  </p>
                </section>
              ))}
              {selected.matched_command_id && (
                <Link
                  href={`/dashboard/commands?command=${selected.matched_command_id}`}
                  className="flex items-center gap-2 text-sm underline underline-offset-4"
                >
                  查看命中指令
                  <ArrowRight className="size-3" />
                </Link>
              )}
              <Alert>
                <ShieldCheck />
                <AlertTitle>群管理操作待联调</AlertTitle>
                <AlertDescription>
                  目标群的机器人管理员权限及官方接口验证完成后，将开放警告和禁言操作。
                </AlertDescription>
              </Alert>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Approval({
  data,
  mutate,
}: {
  data: ConsoleState;
  mutate: (path: string, method: string, body?: unknown) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Policy | null>(null),
    [fresh, setFresh] = useState(false),
    [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState<Policy | null>(null),
    [sample, setSample] = useState("");
  const edit = (policy?: Policy) => {
    setFresh(!policy);
    setSample("");
    setDraft(
      policy
        ? {
            id: policy.id,
            group_openid: policy.group_openid,
            rule_type: policy.rule_type,
            rule_value: policy.rule_value,
            action: policy.action,
            enabled: policy.enabled,
            reject_reason: policy.reject_reason || "",
          }
        : {
            id: crypto.randomUUID(),
            group_openid: "",
            rule_type: "keyword",
            rule_value: "",
            action: "approve",
            enabled: false,
            reject_reason: "",
          },
    );
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (e) {
      toast.add({ title: (e as Error).message, type: "error" });
    } finally {
      setBusy(false);
    }
  };
  const matched =
    draft &&
    (draft.rule_type === "keyword"
      ? !!draft.rule_value && sample.includes(draft.rule_value)
      : draft.rule_value.split(/[\s,]+/).includes(sample.trim()));
  return (
    <div className="flex flex-col gap-5">
      <Alert>
        <ShieldCheck />
        <AlertTitle>两种审批路径，不同的生效时机</AlertTitle>
        <AlertDescription>
          事件驱动审批在收到入群申请后处理；官方自动策略由 QQ
          平台执行。两者均需先验证目标群权限。当前可保存规则草稿，自动执行及官方策略同步待联调。
        </AlertDescription>
      </Alert>
      <div className="flex justify-between gap-3">
        <span className="self-center text-sm text-muted-foreground">
          {data.policies.length} 条规则
        </span>
        <div className="flex gap-2">
          <Button variant="outline" disabled title="官方策略接口尚未完成联调">
            同步官方策略 · 待联调
          </Button>
          <Button onClick={() => edit()}>
            <Plus data-icon="inline-start" />
            新建规则
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        {data.policies.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>群 OpenID</TableHead>
                <TableHead>规则类型</TableHead>
                <TableHead>规则内容</TableHead>
                <TableHead>操作</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>管理</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.policies.map((policy) => (
                <TableRow key={policy.id}>
                  <TableCell className="text-xs" title={policy.group_openid}>
                    {short(policy.group_openid)}
                  </TableCell>
                  <TableCell>
                    {policy.rule_type === "keyword" ? "关键词" : "白名单"}
                  </TableCell>
                  <TableCell className="max-w-48 truncate">
                    {policy.rule_value}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {policy.action === "approve" ? "通过" : "拒绝"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {policy.enabled ? "待联调" : "草稿"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => edit(policy)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="删除规则"
                        onClick={() => setDeleting(policy)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Blank
            title="尚未配置审批规则"
            description="先保存规则草稿，完成群权限和事件推送验证后启用。"
          />
        )}
      </div>
      <Dialog
        open={!!draft}
        onOpenChange={(open) => !open && !busy && setDraft(null)}
      >
        <DialogContent className="max-h-[88dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{fresh ? "新建审批规则" : "编辑审批规则"}</DialogTitle>
            <DialogDescription>
              规则限定在指定群聊；白名单使用成员 OpenID。
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              className="flex flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await mutate(
                    fresh ? "policies" : `policies/${draft.id}`,
                    fresh ? "POST" : "PATCH",
                    draft,
                  );
                  setDraft(null);
                });
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="policy-group">群 OpenID</FieldLabel>
                  <Input
                    id="policy-group"
                    value={draft.group_openid}
                    required
                    maxLength={128}
                    onChange={(e) =>
                      setDraft({ ...draft, group_openid: e.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>规则类型</FieldLabel>
                  <Dropdown
                    label="规则类型"
                    value={draft.rule_type}
                    items={[
                      { value: "keyword", label: "申请内容包含关键词" },
                      { value: "whitelist", label: "成员 OpenID 白名单" },
                    ]}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        rule_type: value as Policy["rule_type"],
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="rule-value">
                    {draft.rule_type === "keyword"
                      ? "关键词"
                      : "OpenID 列表（逗号或换行分隔）"}
                  </FieldLabel>
                  <Textarea
                    id="rule-value"
                    required
                    value={draft.rule_value}
                    maxLength={4000}
                    onChange={(e) =>
                      setDraft({ ...draft, rule_value: e.target.value })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>匹配后的操作</FieldLabel>
                  <Dropdown
                    label="匹配后的操作"
                    value={draft.action}
                    items={[
                      { value: "approve", label: "通过申请" },
                      { value: "reject", label: "拒绝申请" },
                    ]}
                    onChange={(value) =>
                      setDraft({ ...draft, action: value as Policy["action"] })
                    }
                  />
                </Field>
                {draft.action === "reject" && (
                  <Field>
                    <FieldLabel htmlFor="reject-reason">拒绝原因</FieldLabel>
                    <Input
                      id="reject-reason"
                      value={draft.reject_reason || ""}
                      onChange={(e) =>
                        setDraft({ ...draft, reject_reason: e.target.value })
                      }
                    />
                  </Field>
                )}
                <Field>
                  <FieldLabel htmlFor="policy-sample">
                    测试申请内容 / 成员 OpenID
                  </FieldLabel>
                  <Input
                    id="policy-sample"
                    value={sample}
                    onChange={(e) => setSample(e.target.value)}
                  />
                  <p role="status" className="text-xs text-muted-foreground">
                    {!sample
                      ? "输入内容查看本地规则匹配结果"
                      : matched
                        ? `匹配此规则，将${draft.action === "approve" ? "通过" : "拒绝"}申请（实际执行待联调）`
                        : "未匹配此规则"}
                  </p>
                </Field>
                <Alert>
                  <AlertTitle>保存为规则草稿</AlertTitle>
                  <AlertDescription>
                    尚未确认机器人在该群的管理员权限，当前版本不会自动执行审批。
                  </AlertDescription>
                </Alert>
              </FieldGroup>
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => setDraft(null)}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !draft.group_openid.trim() ||
                    !draft.rule_value.trim()
                  }
                >
                  {busy ? "保存中…" : "保存草稿"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Confirm
        open={!!deleting}
        busy={busy}
        title="删除审批规则？"
        description="删除后无法恢复。"
        onClose={() => setDeleting(null)}
        onConfirm={() =>
          void run(async () => {
            await mutate(`policies/${deleting!.id}`, "DELETE");
            setDeleting(null);
          })
        }
      />
    </div>
  );
}

function WebhookPage({ data }: { data: ConsoleState }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    setUrl(
      typeof data.settings.webhookUrl === "string" && data.settings.webhookUrl
        ? data.settings.webhookUrl
        : `${window.location.origin}/api/webhook`,
    );
  }, [data.settings.webhookUrl]);
  const last = data.requests[0];
  return (
    <div className="flex flex-col gap-5">
      <Card size="sm">
        <CardHeader>
          <CardTitle>事件回调地址</CardTitle>
          <CardDescription>
            将此地址填写到 QQ 开放平台的事件订阅配置中。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
            <code className="min-w-0 flex-1 break-all text-xs">{url}</code>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="复制回调地址"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  toast.add({ title: "回调地址已复制", type: "success" });
                } catch {
                  toast.add({
                    title: "无法自动复制，请手动选择地址",
                    type: "error",
                  });
                }
              }}
            >
              <Copy />
            </Button>
          </div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          ["最近请求", when(last?.created_at)],
          [
            "签名校验",
            !last ? "尚未收到请求" : last.processing_result === 'handshake_unsigned' ? '验证握手（无签名）' : last.signature_valid ? "通过" : "失败",
          ],
          ["事件类型", last?.event_type || "—"],
          ["HTTP 状态", last?.http_status || "—"],
        ].map(([title, value]) => (
          <div key={title} className="rounded-xl border bg-card p-4">
            <p className="mb-3 text-xs text-muted-foreground">{title}</p>
            <p className="break-words text-sm font-medium">{value}</p>
          </div>
        ))}
      </div>
      <Alert>
        <CircleHelp />
        <AlertTitle>连接检查</AlertTitle>
        <AlertDescription>
          签名失败时，请核对 QQ_CLIENT_SECRET、签名请求头及原始请求体。IP
          白名单要求与目标机器人事件订阅权限需要在 QQ 平台实际确认。
        </AlertDescription>
      </Alert>
      <Card size="sm">
        <CardHeader>
          <CardTitle>最近请求</CardTitle>
          <CardDescription>最多显示最近 100 次请求</CardDescription>
        </CardHeader>
        <CardContent>
          {!data.requests.length ? (
            <Blank
              title="尚未收到 Webhook 请求"
              description="在 QQ 平台验证回调地址，或在群里 @机器人发送消息。"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>事件类型</TableHead>
                  <TableHead>签名</TableHead>
                  <TableHead>处理结果</TableHead>
                  <TableHead>耗时</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.requests.map((request) => (
                  <TableRow key={request.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {when(request.created_at)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {request.event_type || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          request.signature_valid || request.processing_result === 'handshake_unsigned' ? "secondary" : "destructive"
                        }
                      >
                        {request.processing_result === 'handshake_unsigned' ? '验证握手（无签名）' : request.signature_valid ? "通过" : "失败"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {request.processing_result}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {request.duration_ms} ms
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SettingsPage({
  data,
  mutate,
}: {
  data: ConsoleState;
  mutate: (path: string, method: string, body?: unknown) => Promise<void>;
}) {
  const [clear, setClear] = useState(false),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-5">
      <Card size="sm">
        <CardHeader>
          <CardTitle>机器人信息</CardTitle>
          <CardDescription>仅展示脱敏信息和配置状态</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">AppID</dt>
              <dd className="font-mono text-sm">
                {String(data.settings.appIdMasked || "未配置")}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">凭据状态</dt>
              <dd className="text-sm">
                {data.settings.configured?.QQ_CLIENT_SECRET
                  ? "已配置 · 实际可用性由消息请求验证"
                  : "尚未配置"}
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">Token 缓存</dt>
              <dd className="text-sm">实例内存缓存 · 尚未接入共享 Redis</dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">平台身份</dt>
              <dd className="text-sm">复用 BreezeverPlatform 管理员账号</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>数据库 Schema</CardTitle>
          <CardDescription>独立 bpe_bot 命名空间，状态只读</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">初始化模式</dt>
              <dd>
                <Badge variant="outline">
                  {data.settings.schemaMode || "未配置"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">当前版本</dt>
              <dd>{data.settings.schemaVersion ?? "尚未初始化"}</dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">
                代码期望版本
              </dt>
              <dd>{String(data.settings.expectedSchemaVersion ?? "1")}</dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">最近迁移时间</dt>
              <dd>{when(data.settings.schemaAppliedAt)}</dd>
            </div>
            <div>
              <dt className="mb-1 text-xs text-muted-foreground">最近迁移来源</dt>
              <dd>{data.settings.schemaAppliedBy || "暂无记录"}</dd>
            </div>
          </dl>
          {data.settings.schemaMode === "auto" && (
            <Alert className="mt-4">
              <AlertTitle>运行时自动迁移已开启</AlertTitle>
              <AlertDescription>
                首次部署完成后，请将生产环境改为 verify 并重新部署。
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>环境变量检查</CardTitle>
          <CardDescription>配置值不会显示在控制台中</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col">
            {Object.entries(data.settings.configured || {}).map(
              ([key, value]) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-4 border-b py-3 last:border-0"
                >
                  <code className="break-all text-xs">{key}</code>
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-2 text-xs",
                      value ? "text-success" : "text-muted-foreground",
                    )}
                  >
                    <span className="status-dot" />
                    {value ? "已配置" : "未配置"}
                  </span>
                </div>
              ),
            )}
          </div>
        </CardContent>
      </Card>
      <Card size="sm">
        <CardHeader>
          <CardTitle>清空消息日志</CardTitle>
          <CardDescription>
            永久删除运行日志。事件去重记录会保留，防止历史事件重复执行。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => {
              setClear(true);
              setConfirmation("");
            }}
          >
            <Trash2 data-icon="inline-start" />
            清空日志
          </Button>
        </CardContent>
      </Card>
      <AlertDialog
        open={clear}
        onOpenChange={(value) => !busy && setClear(value)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>永久清空消息日志？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作不可撤销。输入 confirm clear 后确认。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="clear-confirmation">确认文字</FieldLabel>
            <Input
              id="clear-confirmation"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy || confirmation !== "confirm clear"}
              onClick={async () => {
                setBusy(true);
                try {
                  await mutate("logs", "DELETE", { confirmation });
                  setClear(false);
                } catch (e) {
                  toast.add({ title: (e as Error).message, type: "error" });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "清空中…" : "永久清空"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
