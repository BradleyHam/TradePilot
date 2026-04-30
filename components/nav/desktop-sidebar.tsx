'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PenLine, Briefcase, DollarSign, CalendarDays, Settings, Hammer } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/entry', label: 'Entry', icon: PenLine },
  { href: '/jobs', label: 'Jobs', icon: Briefcase },
  { href: '/money', label: 'Money', icon: DollarSign },
  { href: '/schedule', label: 'Schedule', icon: CalendarDays },
];

export function DesktopSidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden md:flex md:flex-col w-60 shrink-0 border-r border-border bg-card h-screen sticky top-0">
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
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
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

      {/* Settings */}
      <div className="px-3 pb-4 border-t border-border pt-4">
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
