import React from 'react';
export const navigation = [];
export function usePathname() { return '/'; }
export function useRouter() { return { push: path => navigation.push(path) }; }
export function redirect(path) { throw new Error('redirect ' + path); }
export default function Link(props) { const attributes = { ...props }; delete attributes.prefetch; return React.createElement('a', attributes); }
