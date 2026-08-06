'use client';

/**
 * JobTeamPanel — owner-only "who's on this job" chips on the job detail
 * sheet. Tapping a person toggles their job-level assignment (migration
 * 035). Assigned employees see the job + its bookings on their phone and
 * can log hours against it; unassigned employees see nothing.
 *
 * Hidden entirely when there are no employees (no empty visualisations)
 * or when the viewer isn't the owner.
 */

import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Users, Check } from 'lucide-react';

export function JobTeamPanel({ jobId }: { jobId: string }) {
  const { role, teamMembers, jobAssignments, setJobAssignees } = useStore();

  if (role !== 'owner') return null;
  const employees = teamMembers.filter((m) => m.role === 'employee');
  if (employees.length === 0) return null;

  const assigned = new Set(
    jobAssignments.filter((a) => a.jobId === jobId).map((a) => a.userId),
  );

  function toggle(userId: string) {
    const next = new Set(assigned);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    setJobAssignees(jobId, [...next]);
  }

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
        <Users size={13} /> Team on this job
      </p>
      <div className="flex flex-wrap gap-2">
        {employees.map((m) => {
          const on = assigned.has(m.userId);
          const name = m.displayName || 'Employee';
          return (
            <button
              key={m.userId}
              type="button"
              onClick={() => toggle(m.userId)}
              aria-pressed={on}
              className={cn(
                'min-h-[44px] px-4 rounded-full border text-sm font-medium transition-colors flex items-center gap-1.5',
                on
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/30',
              )}
            >
              {on && <Check size={15} />}
              {name}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground mt-1.5">
        {assigned.size === 0
          ? 'Nobody assigned — this job is invisible to your staff.'
          : 'Assigned people see this job on their phone and can log hours + photos against it.'}
      </p>
    </div>
  );
}
