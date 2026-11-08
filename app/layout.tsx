import type { Metadata } from 'next'
import { Toaster } from '@/components/ui/toast'
import './globals.css'

export const metadata: Metadata = { title: 'BPE BOT · 运行控制台', description: 'BreezeverPlatform QQ 机器人管理控制台', robots: { index: false, follow: false } }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body><Toaster timeout={2200} limit={3}>{children}</Toaster></body></html>
}
