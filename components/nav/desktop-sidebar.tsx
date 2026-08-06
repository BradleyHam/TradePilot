'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, PenLine, Briefcase, DollarSign, CalendarDays, Settings, Hammer, ListChecks, Sparkles, Megaphone, Paintbrush, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStore } from '@/lib/store';

// Leads sits between Entry and Jobs — the natural flow is Entry (log
// an enquiry) → Leads (chase the open ones) → Jobs (work the booked
// ones) → Marketing (showcase the finished ones). Sparkles reads as
// "opportunity"; Megaphone reads as "promote" without competing with
// Briefcase (Jobs) or PenLine (Entry).
const NAV_ITEMS = [
  { href: '/home', label: 'Home', icon: Home },
  { href: '/entry', label: 'Entry', icon: PenLine },
  { href: '/entries', label: 'All entries', icon: ListChecks },
  { href: '/leads', label: 'Leads', icon: Sparkles },
  { href: '/jobs', label: 'Jobs', icon: Briefcase },
  { href: '/money', label: 'Money', icon: DollarSign },
  { href: '/schedule', label: 'Schedule', icon: CalendarDays },
  // Stock sits after Schedule: it's a "before/after the day's work"
  // check (what's in the van, what to buy), not part of the log→chase→
  // work flow above. NOT in the mobile bottom nav — that's at its
  // 7-item limit — phones reach it via the Home quick-add card.
  { href: '/stock', label: 'Paint stock', icon: Paintbrush },
  { href: '/marketing', label: 'Marketing', icon: Megaphone },
];

// Money-free employee nav (see BottomNav for rationale).
const EMPLOYEE_NAV_ITEMS = [
  { href: '/my/hours', label: 'Log hours', icon: Clock },
  { href: '/my/schedule', label: 'My schedule', icon: CalendarDays },
];

export function DesktopSidebar() {
  const pathname = usePathname();
  const { role } = useStore();
  const isEmployee = role === 'employee';
  const navItems = isEmployee ? EMPLOYEE_NAV_ITEMS : NAV_ITEMS;

  return (
    <aside className="hidden md:flex md:flex-col w-64 shrink-0 border-r border-border bg-card h-screen sticky top-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-6 py-5 border-b border-border">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
          <Hammer size={16} className="text-primary-foreground" strokeWidth={2.2} />
        </div>
        <div>
          <p className="font-bold text-sm leading-none text-foreground">TradePilot</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Lakeside Painting</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-5 py-4 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              <Icon size={18} strokeWidth={active ? 2.2 : 1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Settings — owner only. Employees have no settings page (it exposes
          GST + business config); they sign out from their Hours screen. */}
      <div className={cn('px-5 pb-4 border-t border-border pt-4', isEmployee && 'hidden')}>
        <Link
          href="/settings"
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
            pathname === '/settings'
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
        >
          <Settings size={18} strokeWidth={1.8} />
          Settings
        </Link>
      </div>
    </aside>
  );
}
