import { lazy, Suspense } from 'react';

const Discussion = lazy(() => import('./discussion.jsx'));

export function DiscussionPanel({ kind, id }) {
  return <Suspense fallback={<section className="discussion" aria-busy="true"><h2>队内讨论</h2></section>}>
    <Discussion subject={{ kind, id }} />
  </Suspense>;
}
