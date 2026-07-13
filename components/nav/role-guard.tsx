'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useStore } from '@/lib/store';

/**
 * Defence-in-depth UI gate for employees.
 *
 * The database (RLS) is the real guard — an employee simply cannot read
 * money no matter what URL they hit. This component is the polish on top:
 * it keeps an employee's browser inside the `/my/*` area so they never
 * land on an owner page that would just render empty/broken for them.
 *
 * Only redirects once the store has finished loading (so the role has
 * actually resolved — role defaults to 'owner' during load, and we don't
 * want to bounce the owner on a slow first paint). Renders nothing.
 */
export function RoleGuard() {
  const { role, loading } = useStore();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (role !== 'employee') return;
    // Allow the employee area; bounce everything else to their hours screen.
    if (pathname.startsWith('/my')) return;
    router.replace('/my/hours');
  }, [role, loading, pathname, router]);

  return null;
}
