'use client';

import { useState } from 'react';
import { useStore } from '@/lib/store';
import { Job, JobStatus } from '@/lib/types';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { JobCard } from '@/components/jobs/job-card';
import { JobDetailSheet } from '@/components/jobs/job-detail-sheet';
import { JobForm } from '@/components/jobs/job-form';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Briefcase, Plus, Search, Filter } from 'lucide-react';
import { JOB_STATUSES } from '@/lib/mock-data';
import { jobStats } from '@/lib/job-stats';
import { cn } from '@/lib/utils';

// Filter values: 'all', a synthetic 'coming-up' group, or a literal JobStatus.
// 'coming-up' is everything you've got in the pipeline that isn't yet on the
// brush — i.e. NOT in-progress, NOT done. Splits cleanly with In progress.
type FilterValue = 'all' | 'coming-up' | JobStatus;

const COMING_UP_STATUSES: JobStatus[] = [
  'lead', 'quoted', 'accepted', 'booked',
];

const FILTER_OPTIONS: { label: string; value: FilterValue }[] = [
  { label: 'All',         value: 'all' },
  { label: 'In progress', value: 'in-progress' },
  { label: 'Coming up',   value: 'coming-up' },
  { label: 'Completed',   value: 'completed' },
  { label: 'Leads',       value: 'lead' },
  { label: 'Quoted',      value: 'quoted' },
  { label: 'Booked',      value: 'booked' },
  { label: 'Invoiced',    value: 'invoiced' },
  { label: 'Paid',        value: 'paid' },
  // Sits at the end — only relevant when reviewing what didn't convert.
  { label: 'Lost',        value: 'lost' },
];

export default function JobsPage() {
  const { jobs, entries, addJob, businessId } = useStore();
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [showAddJob, setShowAddJob] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterValue>('all');

  const filteredJobs = jobs.filter((j) => {
    const matchesFilter =
      // 'All' hides lost jobs by default — they only appear when explicitly
      // requested via the 'Lost' chip. Avoids cluttering the default view
      // with dead leads while still leaving them findable.
      filter === 'all' ? j.status !== 'lost'
      : filter === 'coming-up' ? COMING_UP_STATUSES.includes(j.status)
      : j.status === filter;
    const matchesSearch =
      !search ||
      j.name.toLowerCase().includes(search.toLowerCase()) ||
      j.clientName.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  // Stats are derived from entries via the shared util in lib/job-stats.ts so
  // this list view and the detail sheet always agree.

  function handleAddJob(data: Omit<Job, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>) {
    addJob({
      id: `job_${Date.now()}`,
      businessId: businessId ?? '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    });
    setShowAddJob(false);
  }

  const pipelineValue = jobs
    .filter((j) => !['paid', 'lost'].includes(j.status))
    .reduce((s, j) => s + (j.quoteAmount ?? j.estimatedValue ?? 0), 0);

  return (
    <div className="flex flex-col min-h-full">
      <PageHeader
        title="Jobs"
        subtitle={`${jobs.filter((j) => ['in-progress', 'booked'].includes(j.status)).length} active · $${pipelineValue.toLocaleString('en-NZ')} pipeline`}
        action={
          <Button size="sm" className="bg-primary h-9" onClick={() => setShowAddJob(true)}>
            <Plus size={16} className="mr-1" /> Add job
          </Button>
        }
      />

      <div className="px-4 md:px-6 space-y-3">
        {/* Search */}
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search jobs or clients..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-10 pl-9 pr-3 rounded-xl border border-input bg-card text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {FILTER_OPTIONS.map(({ label, value }) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={cn(
                'shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
                filter === value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/30'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Job list */}
        {filteredJobs.length === 0 ? (
          <EmptyState
            icon={Briefcase}
            title="No jobs yet"
            description="Add your first job to start tracking work, hours, and profit."
            action={
              <Button className="bg-primary" onClick={() => setShowAddJob(true)}>
                <Plus size={16} className="mr-1.5" /> Add first job
              </Button>
            }
          />
        ) : (
          <div className="space-y-2.5 pb-6">
            {filteredJobs.map((job) => {
              const stats = jobStats(job, entries);
              return (
                <JobCard
                  key={job.id}
                  job={job}
                  totalHours={stats.totalHours}
                  totalExpenses={stats.totalExpenses}
                  totalIncome={stats.totalIncome}
                  expectedProfit={stats.expectedProfit}
                  expectedIsConfident={stats.expectedIsConfident}
                  onClick={() => setSelectedJob(job)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Job detail sheet */}
      <JobDetailSheet
        job={selectedJob}
        open={!!selectedJob}
        onClose={() => setSelectedJob(null)}
      />

      {/* Add job sheet */}
      <Sheet open={showAddJob} onOpenChange={setShowAddJob}>
        <SheetContent side="bottom" className="h-[92vh] overflow-y-auto rounded-t-2xl px-4 pb-10">
          <SheetHeader className="pb-4">
            <SheetTitle>New job</SheetTitle>
          </SheetHeader>
          <JobForm onSave={handleAddJob} onCancel={() => setShowAddJob(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
