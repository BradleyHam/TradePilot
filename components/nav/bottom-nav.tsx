'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Plus, Briefcase, DollarSign, CalendarDays, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';

// Five calm phone destinations. Leads live under Work, while secondary
// tools (stock, marketing, entries, settings) live in Home's More sheet.
// The centre Log action is deliberately louder than navigation because
// capturing the day is the most common 5:30pm job.
type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  activeOn?: string[];
  primary?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/jobs', label: 'Work', icon: Briefcase, activeOn: ['/jobs', '/leads'] },
  { href: '/entry', label: 'Log', icon: Plus, primary: true },
  { href: '/schedule', label: 'Schedule', icon: CalendarDays },
  { href: '/money', label: 'Money', icon: DollarSign },
];

// Employees see a deliberately tiny, money-free nav — just log hours and
// check their schedule. Everything financial is absent (and RLS-blocked
// even if the URL were typed in directly).
const EMPLOYEE_NAV_ITEMS: NavItem[] = [
  { href: '/my/hours', label: 'Hours', icon: Clock },
  { href: '/my/schedule', label: 'Schedule', icon: CalendarDays },
];

export function BottomNav() {
  const pathname = usePathname();
  const { role } = useStore();
  const items = role === 'employee' ? EMPLOYEE_NAV_ITEMS : NAV_ITEMS;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/90 backdrop-blur-lg border-t border-border/60 shadow-nav md:hidden">
      <div className="flex items-center justify-around h-16 px-2 pb-safe">
        {items.map(({ href, label, icon: Icon, activeOn, primary = false }) => {
          const activePaths = activeOn ?? [href];
          const active = activePaths.some((path) => pathname === path || pathname.startsWith(path + '/'));
          return (
            <Link
              key={href}
              href={href}
              aria-label={primary ? 'Log something' : label}
              className={cn(
                'relative flex flex-col items-center justify-center gap-1 flex-1 mx-0.5 py-2 rounded-2xl transition-all min-h-[52px]',
                primary
                  ? 'text-primary-foreground'
                  : active
                  ? 'text-primary bg-primary/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
              )}
            >
              {primary ? (
                <>
                  <span className="absolute -top-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary shadow-btn ring-4 ring-background">
                    <Icon size={24} strokeWidth={2.3} />
                  </span>
                  <span className="mt-7 text-[11px] font-semibold leading-none text-primary">{label}</span>
                </>
              ) : (
                <>
                  <Icon
                    size={22}
                    strokeWidth={active ? 2.2 : 1.8}
                    className={cn(active && 'drop-shadow-sm')}
                  />
                  <span className={cn('text-[11px] font-medium leading-none', active && 'font-semibold')}>
                    {label}
                  </span>
                </>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
