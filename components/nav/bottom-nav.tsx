'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, PenLine, Briefcase, DollarSign, CalendarDays, Sparkles, Megaphone } from 'lucide-react';
import { cn } from '@/lib/utils';

// Leads slots between Entry and Jobs to match the desktop sidebar order
// and the user's mental flow (log → chase → work → showcase).
//
// NOTE: this is now SEVEN items — one past the old "six is the crowding
// limit" guidance. On a 380px phone each tab still gets ~54px (above the
// 44px tap-target floor), so it holds, but it's tight. If an eighth tab
// ever lands, move the least-tapped ones (Schedule / Marketing) behind a
// "More" menu rather than shrinking further.
const NAV_ITEMS = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/entry', label: 'Entry', icon: PenLine },
  { href: '/leads', label: 'Leads', icon: Sparkles },
  { href: '/jobs', label: 'Jobs', icon: Briefcase },
  { href: '/money', label: 'Money', icon: DollarSign },
  { href: '/schedule', label: 'Schedule', icon: CalendarDays },
  { href: '/marketing', label: 'Marketing', icon: Megaphone },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border md:hidden">
      <div className="flex items-center justify-around h-16 px-2 pb-safe">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex flex-col items-center justify-center gap-1 flex-1 py-2 rounded-xl transition-colors min-h-[52px]',
                active
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon
                size={22}
                strokeWidth={active ? 2.2 : 1.8}
                className={cn(active && 'drop-shadow-sm')}
              />
              <span className={cn('text-[10px] font-medium leading-none', active && 'font-semibold')}>
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
