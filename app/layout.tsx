import type { Metadata, Viewport } from 'next';
import './globals.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: { default: 'Kapok · 训练记录本', template: '%s · Kapok' }, description: '回看场上的配合，记录自己的下一步。', robots: { index: false, follow: false }, icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#f4f5f2' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body><a className="skip-link" href="#main-content">跳到主要内容</a>{children}</body></html>; }
