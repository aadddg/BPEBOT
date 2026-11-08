import Link from "next/link";
import { Bot } from "lucide-react";
import { platformLoginUrl } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const sso = process.env.PLATFORM_AUTH_MODE === 'sso';
  let loginUrl: string | null = null;
  try {
    loginUrl = platformLoginUrl();
  } catch {
    /* Never expose configuration values. */
  }
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <div className="flex w-full max-w-md flex-col gap-5">
        <div className="flex items-center justify-center gap-2 text-sm font-semibold">
          <Bot className="size-5" />
          BreezeverPlatform · BPE BOT
        </div>
        <Card>
          <CardHeader>
            <CardTitle>使用平台账号登录</CardTitle>
            <CardDescription>
              机器人管理沿用 BreezeverPlatform 的账号与管理员权限。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {reason === "forbidden" && (
              <Alert variant="destructive">
                <AlertTitle>需要管理员权限</AlertTitle>
                <AlertDescription>
                  当前平台账号无权访问机器人管理控制台。
                </AlertDescription>
              </Alert>
            )}
            {reason === "unavailable" && (
              <Alert variant="destructive">
                <AlertTitle>暂时无法验证平台身份</AlertTitle>
                <AlertDescription>
                  请检查平台连接与身份验证配置后重试。
                </AlertDescription>
              </Alert>
            )}
            <p className="text-sm leading-7 text-muted-foreground">
              {sso ? '点击下方按钮前往平台授权，完成后会返回管理台。' : '请先在平台完成登录，再返回此处。'}
            </p>
            {loginUrl ? (
              <Button render={<a href={loginUrl} />} nativeButton={false}>
                {sso ? '使用平台账号安全登录' : '前往平台登录'}
              </Button>
            ) : (
              <Alert>
                <AlertTitle>平台登录地址尚未配置</AlertTitle>
                <AlertDescription>
                  请联系管理员完成平台连接配置。
                </AlertDescription>
              </Alert>
            )}
            {!sso && <Button
              variant="outline"
              render={<Link href="/dashboard" />}
              nativeButton={false}
            >
              已在平台登录，进入管理台
            </Button>}
            <p className="text-xs leading-6 text-muted-foreground">
              {sso ? '只有平台管理员可访问。登录由平台授权，无需共享平台 Cookie。' : '只有平台管理员可访问。平台与管理台需使用同一主机或正确配置共享登录域。'}
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
