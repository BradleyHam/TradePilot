'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StoreProvider } from '@/lib/store';
import { BottomNav } from '@/components/nav/bottom-nav';
import { DesktopSidebar } from '@/components/nav/desktop-sidebar';
import { supabase } from '@/lib/supabase/client';

type AuthState = 'loading' | 'signed-in' | 'signed-out';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [authState, setAuthState] = useState<AuthState>('loading');

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setAuthState(data.session ? 'signed-in' : 'signed-out');
      if (!data.session) router.replace('/login');
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      const next: AuthState = session ? 'signed-in' : 'signed-out';
      setAuthState(next);
      if (!session) router.replace('/login');
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [router]);

  if (authState !== 'signed-in') {
    // Loading or signed-out — render nothing while we resolve / redirect.
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        {authState === 'loading' ? 'Loading…' : 'Redirecting…'}
      </div>
    );
  }

  return (
    <StoreProvider>
      <div className="flex h-full min-h-screen">
        <DesktopSidebar />
        <main className="flex-1 flex flex-col min-h-screen overflow-y-auto pb-20 md:pb-0">
          {children}
        </main>
      </div>
      <BottomNav />
    </StoreProvider>
  );
}
