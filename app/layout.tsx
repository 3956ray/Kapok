import type { Metadata, Viewport } from 'next';
import './globals.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: { default: 'Kapok 木棉 · 训练记录本', template: '%s · Kapok 木棉' }, description: '一次训练，一段可以回看的思考。所有者私有合成审阅环境。', robots: { index: false, follow: false }, icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#f6f5f0' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body><a className="skip-link" href="#main-content">跳到主要内容</a>{children}</body></html>; }
