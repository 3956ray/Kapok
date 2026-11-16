import React from 'react';
export const navigation = [];
const router = { push: path => navigation.push(path), replace: path => navigation.push(path), refresh: () => navigation.push('refresh') };
export function usePathname() { return '/'; }
export function useRouter() { return router; }
export function redirect(path) { throw new Error('redirect ' + path); }
export default function Link(props) { const attributes = { ...props }; delete attributes.prefetch; return React.createElement('a', attributes); }

export function useLinkStatus() { return { pending: false }; }
