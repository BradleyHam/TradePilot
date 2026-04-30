'use client';

import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/shared/page-header';
import { useStore } from '@/lib/store';
import { supabase } from '@/lib/supabase/client';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import {
  Building2, User, Palette, Bell, Database, Info, ChevronRight, Hammer, LogOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingRowProps {
  icon: React.ElementType;
  label: string;
  value?: string;
  badge?: string;
  onClick?: () => void;
}

function SettingRow({ icon: Icon, label, value, badge, onClick }: SettingRowProps) {
  return (
    <button
      className="flex items-center gap-3 w-full py-3 px-4 hover:bg-muted/50 active:bg-muted transition-colors text-left"
      onClick={onClick}
    >
      <div className="w-8 h-8 rounded-xl bg-muted flex items-center justify-center shrink-0">
        <Icon size={15} className="text-muted-foreground" strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {value && <p className="text-xs text-muted-foreground mt-0.5 truncate">{value}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {badge && (
          <Badge variant="secondary" className="text-xs">{badge}</Badge>
        )}
        <ChevronRight size={14} className="text-muted-foreground" />
      </div>
    </button>
  );
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-4 py-3 border-b border-border">
        {title}
      </p>
      <div className="divide-y divide-border">
        {children}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { jobs, entries, settings } = useStore();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace('/login');
  }
  // We don't currently fetch the businesses row into the store; the only thing
  // we need from it is the name, and right now it's hardcoded ("Lakeside Painting").
  const businessName = 'Lakeside Painting';
  const industry = 'painting';
  const gstMode = settings.find((s) => s.key === 'gst_mode')?.value ?? 'on';
  const gstRate = settings.find((s) => s.key === 'gst_rate')?.value ?? '0.15';

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader title="Settings" />

      <div className="px-4 md:px-6 pb-6 space-y-4">
        {/* Business card */}
        <div className="bg-primary rounded-2xl p-4 flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-white/20 flex items-center justify-center">
            <Hammer size={22} className="text-white" strokeWidth={1.8} />
          </div>
          <div>
            <p className="font-bold text-white text-base">{businessName}</p>
            <p className="text-white/70 text-sm capitalize">{industry}</p>
          </div>
          <Badge variant="outline" className="ml-auto border-white/30 text-white/80 text-xs">
            {jobs.length} jobs · {entries.length} entries
          </Badge>
        </div>

        {/* Business */}
        <SettingSection title="Business">
          <SettingRow icon={Building2} label="Business name" value={businessName} />
          <SettingRow icon={User} label="Owner" value="Brad Hamilton" />
          <SettingRow icon={Palette} label="Industry" value="Painting" />
        </SettingSection>

        {/* GST */}
        <SettingSection title="GST">
          <SettingRow icon={Database} label="GST mode" value={gstMode === 'on' ? 'On' : 'Off'} />
          <SettingRow icon={Database} label="GST rate" value={`${(Number(gstRate) * 100).toFixed(0)}%`} />
        </SettingSection>

        {/* Preferences */}
        <SettingSection title="Preferences">
          <SettingRow icon={Bell} label="Notifications" value="Coming soon" badge="Soon" />
          <SettingRow icon={Palette} label="Appearance" value="Light mode" />
        </SettingSection>

        {/* Data */}
        <SettingSection title="Data & integrations">
          <SettingRow icon={Database} label="Connect to Supabase" value="Set up your database" badge="Setup" />
          <SettingRow icon={Database} label="Export data" value="Download CSV" badge="Soon" />
        </SettingSection>

        {/* About */}
        <SettingSection title="About">
          <SettingRow icon={Info} label="Version" value="0.1.0 MVP" />
          <SettingRow icon={Database} label="Connected" value="Supabase" badge="Live" />
        </SettingSection>

        {/* Account */}
        <SettingSection title="Account">
          <SettingRow icon={LogOut} label="Sign out" onClick={handleSignOut} />
        </SettingSection>
      </div>
    </div>
  );
}
