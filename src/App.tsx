import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  ExternalLink,
  FileCode2,
  Flame,
  GitBranch,
  GitPullRequest,
  LayoutDashboard,
  Loader2,
  LockKeyhole,
  LogOut,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react';
import { api, dateTime, duration, post, relative } from './api';
import {
  statuses,
  type Actor,
  type AuditEvent,
  type Feedback,
  type Metric,
  type Proposal,
  type RequestRecord,
  type Settings,
  type Status,
} from './shared';
type Route = {
  page:
    'dashboard' | 'requests' | 'activity' | 'insights' | 'settings' | 'detail' | 'review' | 'admin';
  id?: string;
};
type ActivityRow = AuditEvent & { title: string };
type Session = { actor: Actor; mode: string };
type RequestRow = Omit<RequestRecord, 'proposal'> & {
  proposal: Pick<Proposal, 'commit' | 'checks'> | null;
};
const routeFromHash = (): Route => {
  const [page, id] = location.hash.slice(2).split('/');
  return {
    page: ([
      'dashboard',
      'requests',
      'activity',
      'insights',
      'settings',
      'detail',
      'review',
      'admin',
    ].includes(page)
      ? page
      : 'dashboard') as Route['page'],
    id,
  };
};
function IconLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="icon-label">
      {icon}
      {children}
    </span>
  );
}
export function Badge({ status }: { status: Status }) {
  const cls =
    status === 'Awaiting approval'
      ? 'approval'
      : status === 'Pushed'
        ? 'success'
        : status === 'Failed' || status === 'Rejected'
          ? 'danger'
          : ['Analyzing', 'Implementing', 'Validating'].includes(status)
            ? 'working'
            : 'neutral';
  return (
    <span className={`badge ${cls}`}>
      <span className="status-dot" />
      {status}
    </span>
  );
}
function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <MessageSquare size={24} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function MetricCard({ metric }: { metric: Metric }) {
  return (
    <div className="metric">
      <div className="metric-name">
        {metric.label}
        <span className="metric-info" title={metric.definition} aria-label={metric.definition}>
          i
        </span>
      </div>
      <div className="metric-value">
        {metric.value === null
          ? '—'
          : metric.unit === 'duration'
            ? duration(metric.value)
            : metric.unit === 'percent'
              ? `${Math.round(metric.value)}%`
              : metric.value}
      </div>
      <div className="metric-caption">
        {metric.samples
          ? `${metric.samples} ${metric.samples === 1 ? 'request' : 'requests'} measured`
          : 'Waiting for your first measurement'}
      </div>
    </div>
  );
}
export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [session, setSession] = useState<Session | null>(null);
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [config, setConfig] = useState<Settings | null>(null);
  const [codingConnected, setCodingConnected] = useState(true);
  const [error, setError] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [modal, setModal] = useState(false);
  const closeFeedback = useCallback(() => setModal(false), []);
  const [mobile, setMobile] = useState(false);
  const [toast, setToast] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  async function logOut() {
    setLoggingOut(true);
    try {
      await logOutAdmin();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log out. Please try again.');
      setLoggingOut(false);
    }
  }
  const navigate = useCallback((page: Route['page'], id?: string) => {
    location.hash = `/${page}${id ? '/' + id : ''}`;
    setMobile(false);
    window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const fn = () => setRoute(routeFromHash());
    addEventListener('hashchange', fn);
    return () => removeEventListener('hashchange', fn);
  }, []);
  const refresh = useCallback(async (admin = false) => {
    const [r, a, m, s] = await Promise.all([
      admin ? api<RequestRow[]>('/requests') : Promise.resolve([]),
      admin ? api<ActivityRow[]>('/activity') : Promise.resolve([]),
      admin ? api<{ metrics: Metric[] }>('/metrics') : Promise.resolve({ metrics: [] }),
      api<{ settings: Settings; integrations: { codingReady: boolean } }>('/settings'),
    ]);
    setRows(r);
    setActivity(a);
    setMetrics(m.metrics);
    setConfig(s.settings);
    setCodingConnected(s.integrations.codingReady);
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await api<Session>('/me');
        if (active) {
          setSession(me);
          await refresh(me.actor.role === 'admin');
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Could not connect.');
      } finally {
        if (active) setInitializing(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!session || session.actor.role !== 'admin') return;
    const timer = setInterval(() => {
      refresh(true).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [session, refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  const notify = (text: string) => {
    setToast(text);
    void refresh(session?.actor.role === 'admin');
  };
  const awaiting = rows.filter((r) => r.status === 'Awaiting approval').length;
  const active = rows.filter((r) => !['Pushed', 'Rejected', 'Failed'].includes(r.status)).length;
  const nav = [
    { page: 'dashboard' as const, label: 'Overview', icon: <LayoutDashboard size={19} /> },
    { page: 'requests' as const, label: 'Requests', icon: <MessageSquare size={19} /> },
    { page: 'activity' as const, label: 'Activity', icon: <Activity size={19} /> },
    { page: 'insights' as const, label: 'Insights', icon: <ChartIcon /> },
  ];
  if (initializing)
    return (
      <div className="boot">
        <img src="/logo.png" alt="" />
        <h1>Lighting the forge.</h1>
        <Loader2 className="spin" />
      </div>
    );
  if (!session)
    return (
      <div className="boot">
        <img src="/logo.png" alt="" />
        <h1>ORIGIN Hephaestus</h1>
        <p role="alert">{error}</p>
        <button className="button primary" onClick={() => location.reload()}>
          Reconnect <ArrowRight size={16} />
        </button>
      </div>
    );
  if (session.actor.role !== 'admin') {
    if (route.page === 'admin')
      return (
        <div className="public-shell">
          <PublicBrand />
          <main className="public-admin">
            <AdminAccess
              session={session}
              onSaved={setToast}
              onSession={(s) => {
                setSession(s);
                void refresh(s.actor.role === 'admin');
              }}
            />
          </main>
        </div>
      );
    return config ? (
      <PublicOverview config={config} />
    ) : (
      <div className="boot">
        <Loader2 className="spin" />
      </div>
    );
  }
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? 'is-open' : ''}`}>
        <a className="brand" href="#/dashboard">
          <img src="/logo.png" alt="ORIGIN Hephaestus flame" />
          <span>
            <strong>ORIGIN</strong>
            <small>HEPHAESTUS</small>
          </span>
        </a>
        <div className="workspace-label">DEVELOPMENT WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.page}
              className={`nav-item ${route.page === n.page || (n.page === 'requests' && ['detail', 'review'].includes(route.page)) ? 'selected' : ''}`}
              onClick={() => navigate(n.page)}
            >
              {n.icon}
              <span>{n.label}</span>
              {n.page === 'requests' && awaiting > 0 && (
                <span className="nav-count">{awaiting}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <div className="forge-symbol">
            <Flame size={19} />
          </div>
          <strong>
            Built by AI.
            <br />
            Approved by you.
          </strong>
          <p>
            Every change has a human
            <br />
            at the final checkpoint.
          </p>
          <div className="small-line" />
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${route.page === 'settings' ? 'selected' : ''}`}
            onClick={() => navigate('settings')}
          >
            <Settings2 size={19} />
            <span>Settings</span>
          </button>
          <button
            className="nav-item"
            onClick={() => {
              navigate('settings');
              setToast('Integration setup is documented in Settings → Integrations.');
            }}
          >
            <BookOpen size={19} />
            <span>Integration guide</span>
            <ArrowUpRight size={14} />
          </button>
          <div className="profile">
            <span className="avatar">{session.actor.role === 'admin' ? 'A' : 'O'}</span>
            <span>
              <strong>
                {session.actor.role === 'admin' ? 'ORIGIN workspace' : 'Public workspace'}
              </strong>
              <small>
                {session.actor.role === 'admin'
                  ? 'Administrator'
                  : session.actor.role === 'reviewer'
                    ? 'Reviewer'
                    : 'Contributor'}
              </small>
            </span>
            <span className="online-dot" />
          </div>
        </div>
      </aside>
      {mobile && (
        <button
          aria-label="Close navigation"
          className="mobile-overlay"
          onClick={() => setMobile(false)}
        />
      )}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {route.page === 'dashboard'
                ? 'Overview'
                : route.page === 'detail'
                  ? 'Request details'
                  : route.page === 'review'
                    ? 'Review workspace'
                    : route.page.charAt(0).toUpperCase() + route.page.slice(1)}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="system-status">
              <span className="online-dot" />
              Workspace connected
            </span>
            <button
              className="notification"
              title="View recent activity"
              aria-label="View recent activity"
              onClick={() => navigate('activity')}
            >
              <Bell size={18} />
              {awaiting > 0 && <i />}
            </button>
            <button
              className="button secondary admin-logout"
              disabled={loggingOut}
              onClick={() => void logOut()}
            >
              {loggingOut ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />}{' '}
              {loggingOut ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </header>
        <div className="page-content">
          {!codingConnected && (
            <div className="workspace-notice">
              <span>
                <ShieldCheck size={14} />
                <b>Feedback is open.</b>
                <span className="workspace-notice-detail">
                  {' '}
                  Your requests are saved while the workspace connections are completed.
                </span>
              </span>
              <button onClick={() => navigate('settings')}>
                {session.actor.role === 'admin' ? 'Connect workspace' : 'No account needed'}{' '}
                <ArrowUpRight size={13} />
              </button>
            </div>
          )}
          {error && (
            <div className="alert danger" role="alert">
              {error}
              <button onClick={() => setError('')} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
          {route.page === 'dashboard' && (
            <>
              <PageHeading
                eyebrow="YOUR DEVELOPMENT, IN MOTION"
                title="The forge"
                subtitle="A direct line from user feedback to better software."
                action={
                  <button className="button primary" onClick={() => setModal(true)}>
                    <Plus size={17} /> New feedback
                  </button>
                }
              />
              <section className="hero">
                <div className="hero-copy">
                  <div className="eyebrow">
                    <span className="tiny-spark">✳</span> FEEDBACK. FORGED INTO CODE.
                  </div>
                  <h2>
                    Small feedback.
                    <br />
                    <em>Meaningful progress.</em>
                  </h2>
                  <button className="text-button" onClick={() => setModal(true)}>
                    Put an idea into motion <ArrowRight size={16} />
                  </button>
                </div>
                <div className="forge-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="orbit orbit-three" />
                  <div className="art-line left" />
                  <div className="art-line right" />
                  <div className="art-chip feedback-chip">
                    <MessageSquare size={16} /> User feedback
                  </div>
                  <div className="art-center">
                    <img src="/logo.png" alt="" />
                  </div>
                  <div className="art-chip code-chip">
                    <Code2 size={16} /> Better code
                  </div>
                  <span className="art-spark one">✦</span>
                  <span className="art-spark two">+</span>
                </div>
              </section>
              <div className="stats-grid">
                {metrics
                  .filter((m) =>
                    ['development', 'review', 'acceptance', 'completed'].includes(m.key),
                  )
                  .map((m) => (
                    <MetricCard metric={m} key={m.key} />
                  ))}
              </div>
              <section className="pipeline panel">
                <div className="section-heading">
                  <h3>
                    In the pipeline <span className="count">{active}</span>
                  </h3>
                  <span className="subtle">Every idea has a next step</span>
                </div>
                <div className="pipeline-steps">
                  {[
                    {
                      label: 'Submitted',
                      icon: <MessageSquare size={18} />,
                      count: rows.filter((r) => r.status === 'Submitted').length,
                    },
                    {
                      label: 'In the forge',
                      icon: <Flame size={18} />,
                      count: rows.filter((r) =>
                        ['Analyzing', 'Implementing', 'Validating', 'Changes requested'].includes(
                          r.status,
                        ),
                      ).length,
                    },
                    {
                      label: 'Awaiting approval',
                      icon: <ShieldCheck size={18} />,
                      count: awaiting,
                    },
                    {
                      label: 'Pushed to repository',
                      icon: <GitBranch size={18} />,
                      count: rows.filter((r) => r.status === 'Pushed').length,
                    },
                  ].map((s, i) => (
                    <button
                      key={s.label}
                      className={`pipeline-step step-${i}`}
                      onClick={() => navigate('requests')}
                    >
                      <span className="pipeline-icon">{s.icon}</span>
                      <span>
                        <strong>{s.count.toString().padStart(2, '0')}</strong>
                        <small>{s.label}</small>
                      </span>
                      {i < 3 && <ChevronRight className="pipeline-arrow" size={17} />}
                    </button>
                  ))}
                </div>
              </section>
              <div className="dashboard-columns">
                <section className="panel requests-panel">
                  <div className="section-heading">
                    <h3>On the workbench</h3>
                    <button className="text-button" onClick={() => navigate('requests')}>
                      View all <ArrowUpRight size={15} />
                    </button>
                  </div>
                  {rows.length ? (
                    <div className="workbench-list">
                      {rows.slice(0, 4).map((r) => (
                        <button
                          className="workbench-row"
                          key={r.id}
                          onClick={() => navigate('detail', r.id)}
                        >
                          <TypeIcon type={r.type} />
                          <div>
                            <span className="request-id">
                              {r.id} <span>· {r.application}</span>
                            </span>
                            <strong>{r.title}</strong>
                            <Badge status={r.status} />
                          </div>
                          <ChevronRight size={17} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="An open workbench"
                      action={
                        <button className="button secondary" onClick={() => setModal(true)}>
                          <Plus size={15} /> Add your first request
                        </button>
                      }
                    >
                      Your next improvement starts with a little feedback.
                    </Empty>
                  )}
                </section>
                <section className="panel activity-panel">
                  <div className="section-heading">
                    <h3>Recent activity</h3>
                    <span className="live-label">
                      <span className="online-dot" />
                      Live
                    </span>
                  </div>
                  {activity.length ? (
                    <ActivityList items={activity.slice(0, 5)} navigate={navigate} />
                  ) : (
                    <Empty title="Quiet, for now">
                      Request updates, checks and review decisions will appear here as they happen.
                    </Empty>
                  )}
                  <div className="panel-bottom">
                    <LockKeyhole size={13} /> Every action leaves an audit trail.
                  </div>
                </section>
              </div>
              <div className="bottom-note">
                <ShieldCheck size={16} />
                <span>
                  AI moves the work forward. <strong>You stay in control.</strong>
                </span>
                <span className="powered">CRAFTED FOR ORIGIN</span>
              </div>
            </>
          )}
          {route.page === 'requests' && (
            <RequestList rows={rows} onNew={() => setModal(true)} navigate={navigate} />
          )}
          {route.page === 'activity' && (
            <>
              <PageHeading
                eyebrow="A RECORD OF EVERY STEP"
                title="Activity"
                subtitle="The people, decisions and checks behind every change."
              />
              <section className="panel full-activity">
                {activity.length ? (
                  <ActivityList items={activity} navigate={navigate} />
                ) : (
                  <Empty title="Your story starts here">
                    Submit feedback to begin an auditable development journey.
                  </Empty>
                )}
              </section>
            </>
          )}
          {route.page === 'insights' && (
            <>
              <PageHeading
                eyebrow="MEASURE WHAT MOVES YOU FORWARD"
                title="Insights"
                subtitle="Real outcomes. Clear definitions. Development and waiting time kept separate."
              />
              <div className="alert">
                <Activity size={17} />
                Metrics use the latest 500 real requests visible to you.
              </div>
              <div className="insights-grid">
                {metrics.map((m) => (
                  <section className="panel" key={m.key}>
                    <MetricCard metric={m} />
                    <p className="metric-definition">{m.definition}</p>
                  </section>
                ))}
              </div>
              <p className="subtle">
                No synthetic performance numbers. Empty measurements remain empty until an outcome
                is recorded. Samples are shown on every metric.
              </p>
            </>
          )}
          {(route.page === 'detail' || route.page === 'review') && route.id && (
            <RequestDetail
              key={`${route.page}-${route.id}`}
              id={route.id}
              review={route.page === 'review'}
              session={session}
              navigate={navigate}
              notify={notify}
            />
          )}
          {(route.page === 'settings' || route.page === 'admin') && (
            <SettingsPage
              session={session}
              onSaved={notify}
              onSession={(s) => {
                setSession(s);
                void refresh(s.actor.role === 'admin');
              }}
            />
          )}
          <footer className="footer">
            <span>
              ORIGIN <span className="footer-divider">/</span> HEPHAESTUS
            </span>
            <span>Thoughtful changes. Human decisions.</span>
            <span>
              v1.0 <span className="online-dot" />
            </span>
          </footer>
        </div>
      </main>
      {modal && config && (
        <FeedbackModal
          config={config}
          onClose={closeFeedback}
          onSubmit={(r) => {
            setModal(false);
            notify(`${r.id} submitted. The forge is on it.`);
            navigate('detail', r.id);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
function PublicBrand() {
  return (
    <header className="public-header">
      <a className="brand" href="#/dashboard" aria-label="ORIGIN Hephaestus home">
        <img src="/logo.png" alt="ORIGIN Hephaestus flame" />
        <span>
          <strong>ORIGIN</strong>
          <small>HEPHAESTUS</small>
        </span>
      </a>
    </header>
  );
}
function PublicOverview({ config }: { config: Settings }) {
  const [submitted, setSubmitted] = useState<RequestRecord | null>(null);
  return (
    <div className="public-shell">
      <PublicBrand />
      <main className="public-content">
        <section className="hero" aria-labelledby="public-heading">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="tiny-spark">✳</span> FEEDBACK. FORGED INTO CODE.
            </div>
            <h1 id="public-heading">
              Small feedback.
              <br />
              <em>Meaningful progress.</em>
            </h1>
          </div>
          <div className="forge-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit orbit-three" />
            <div className="art-line left" />
            <div className="art-line right" />
            <div className="art-chip feedback-chip">
              <MessageSquare size={16} /> User feedback
            </div>
            <div className="art-center">
              <img src="/logo.png" alt="" />
            </div>
            <div className="art-chip code-chip">
              <Code2 size={16} /> Better code
            </div>
            <span className="art-spark one">✦</span>
            <span className="art-spark two">+</span>
          </div>
        </section>
        {submitted && (
          <div className="submission-receipt" role="status">
            <CheckCircle2 size={22} />
            <div>
              <strong>Thank you. Your feedback has been received.</strong>
              <p>
                Reference <code>{submitted.id}</code>. An administrator will review your feedback.
              </p>
            </div>
            <button aria-label="Dismiss confirmation" onClick={() => setSubmitted(null)}>
              <X size={17} />
            </button>
          </div>
        )}
        <FeedbackModal
          embedded
          config={config}
          onSubmit={(r) => {
            setSubmitted(r);
            document.getElementById('public-heading')?.scrollIntoView({
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'instant'
                : 'smooth',
              block: 'start',
            });
          }}
        />
      </main>
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function ChartIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M4 4v16h17M8 15v-4m5 4V7m5 8v-6" />
    </svg>
  );
}
function TypeIcon({ type }: { type: string }) {
  return (
    <span className={`type-icon ${type}`}>
      {type === 'bug' ? (
        <Code2 size={17} />
      ) : type === 'feature' ? (
        <Sparkles size={17} />
      ) : (
        <ArrowUpRight size={17} />
      )}
    </span>
  );
}
function ActivityList({
  items,
  navigate,
}: {
  items: ActivityRow[];
  navigate: (p: Route['page'], id?: string) => void;
}) {
  return (
    <div className="activity-list">
      {items.map((a, i) => (
        <button
          className="activity-row"
          key={a.id}
          onClick={() => navigate('detail', a.request_id)}
        >
          <span
            className={`activity-node ${a.kind === 'Pushed' || a.kind === 'Approved' ? 'green' : a.kind === 'Failed' || a.kind === 'Rejected' ? 'red' : ''}`}
          >
            {a.kind === 'Approved' || a.kind === 'Pushed' ? (
              <Check size={13} />
            ) : a.kind === 'Comment' ? (
              <MessageSquare size={12} />
            ) : (
              <span />
            )}
          </span>
          <span className="activity-text">
            <strong>
              {a.kind === 'Submitted'
                ? 'New feedback received'
                : a.kind === 'Awaiting approval'
                  ? 'Ready for your review'
                  : a.kind === 'Pushed'
                    ? 'Approved change published'
                    : a.kind}
            </strong>
            <span>{a.title}</span>
            <small>
              {a.request_id} <span>·</span> {relative(a.created_at)}
            </small>
          </span>
          {i === 0 && <span className="new-marker" />}
        </button>
      ))}
    </div>
  );
}
function RequestList({
  rows,
  onNew,
  navigate,
}: {
  rows: RequestRow[];
  onNew: () => void;
  navigate: (p: Route['page'], id?: string) => void;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const filtered = rows.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      (type === 'all' || r.type === type) &&
      `${r.title} ${r.id} ${r.application}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <PageHeading
        eyebrow="FROM FRICTION TO A FIX"
        title="Requests"
        subtitle="Every bug, bright idea and small improvement, in one place."
        action={
          <button className="button primary" onClick={onNew}>
            <Plus size={17} /> New feedback
          </button>
        }
      />
      <div className="request-tabs">
        {[
          { value: 'all', label: 'All requests' },
          { value: 'Awaiting approval', label: 'Awaiting approval' },
          { value: 'Implementing', label: 'Implementing' },
          { value: 'Pushed', label: 'Completed' },
        ].map((t) => (
          <button
            key={t.value}
            className={status === t.value ? 'active' : ''}
            onClick={() => setStatus(t.value)}
          >
            {t.label}
            <span>{rows.filter((r) => t.value === 'all' || r.status === t.value).length}</span>
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="table-toolbar">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Search requests"
              placeholder="Search requests, IDs, applications…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <kbd>/</kbd>
          </label>
          <div className="filters">
            <select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="all">All statuses</option>
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select
              aria-label="Filter by request type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="all">All types</option>
              <option value="bug">Bugs</option>
              <option value="feature">Features</option>
              <option value="improvement">Improvements</option>
            </select>
          </div>
        </div>
        <div className="table-scroll" role="region" tabIndex={0} aria-label="Requests table">
          <table className="request-table">
            <thead>
              <tr>
                <th>REQUEST</th>
                <th>APPLICATION</th>
                <th>STATUS</th>
                <th>
                  SUBMITTED <ArrowDown size={12} />
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} onClick={() => navigate('detail', r.id)}>
                  <td>
                    <div className="table-request">
                      <TypeIcon type={r.type} />
                      <span>
                        <a href={`#/detail/${r.id}`}>{r.title}</a>
                        <small>
                          {r.id} <span>·</span> {r.type}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="app-pill">
                      <span />
                      {r.application}
                    </span>
                  </td>
                  <td>
                    <Badge status={r.status} />
                  </td>
                  <td className="subtle" title={dateTime(r.created_at)}>
                    {relative(r.created_at)}
                  </td>
                  <td>
                    <ChevronRight size={16} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filtered.length && (
          <Empty
            title={rows.length ? 'No matching requests' : 'A little feedback goes a long way'}
            action={
              !rows.length && (
                <button className="button secondary" onClick={onNew}>
                  <Plus size={16} /> Submit feedback
                </button>
              )
            }
          >
            {rows.length
              ? 'Try a different search or filter.'
              : 'Report a bug or share an idea. We’ll take it from there.'}
          </Empty>
        )}
        <div className="table-footer">
          <span>
            {filtered.length} of {rows.length} requests
          </span>
          <span>Updated in real time</span>
        </div>
      </section>
    </>
  );
}
function FeedbackModal({
  config,
  onClose = () => {},
  onSubmit,
  embedded = false,
}: {
  config: Settings;
  onClose?: () => void;
  onSubmit: (r: RequestRecord) => void;
  embedded?: boolean;
}) {
  const [type, setType] = useState<Feedback['type']>('bug');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (embedded) return;
    const el = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
      if (e.key === 'Tab') {
        const focusable = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.modal button,.modal input,.modal textarea,.modal select',
          ),
        ).filter((x) => !x.hasAttribute('disabled'));
        const first = focusable[0],
          last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    document.body.style.overflow = 'hidden';
    document.querySelector<HTMLButtonElement>('.modal .close-button')?.focus();
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = '';
      el?.focus();
    };
  }, [onClose, busy, embedded]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    try {
      onSubmit(await post<RequestRecord>('/requests', { ...data, type }));
      if (embedded) {
        form.reset();
        setType('bug');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submission failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={embedded ? 'embedded-feedback' : 'modal-backdrop'}>
      <section
        className={embedded ? 'feedback-card' : 'modal'}
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-labelledby="feedback-title"
      >
        <div className="modal-header">
          <div className="eyebrow">LET’S MAKE IT BETTER</div>
          {!embedded && (
            <button
              className="close-button"
              onClick={onClose}
              aria-label="Close feedback form"
              disabled={busy}
            >
              <X size={20} />
            </button>
          )}
          <h2 id="feedback-title">What’s on your mind?</h2>
          <p>A little context helps Hephaestus make the right change.</p>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <span className="field-label">FEEDBACK TYPE</span>
            <div className="type-select">
              {[
                { value: 'bug', label: 'Report a bug', icon: <Code2 size={18} /> },
                { value: 'feature', label: 'New feature', icon: <Sparkles size={18} /> },
                { value: 'improvement', label: 'Improvement', icon: <ArrowUpRight size={18} /> },
              ].map((t) => (
                <button
                  type="button"
                  key={t.value}
                  className={type === t.value ? 'active' : ''}
                  onClick={() => setType(t.value as Feedback['type'])}
                >
                  {t.icon}
                  {t.label}
                </button>
              ))}
            </div>
            <label className="field">
              Title{' '}
              <input
                name="title"
                required
                minLength={5}
                maxLength={160}
                placeholder="A short, clear description of the request"
              />
            </label>
            <label className="field">
              Affected application
              <select name="application" required>
                {config.applications.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Description
              <textarea
                name="description"
                required
                minLength={10}
                maxLength={16000}
                rows={3}
                placeholder="What happened, or what would you like to change?"
              />
            </label>
            {type === 'bug' && (
              <>
                <label className="field">
                  Steps to reproduce
                  <textarea
                    name="steps"
                    required
                    maxLength={8000}
                    rows={3}
                    placeholder={'1. Open the application\n2. Navigate to…\n3. Observe…'}
                  />
                </label>
                <label className="field">
                  Actual behavior
                  <textarea
                    name="actual"
                    required
                    maxLength={8000}
                    rows={2}
                    placeholder="What happens right now?"
                  />
                </label>
              </>
            )}
            <label className="field">
              Expected behavior
              <textarea
                name="expected"
                required
                minLength={3}
                maxLength={8000}
                rows={2}
                placeholder="What should happen instead?"
              />
            </label>
            <details className="context-details">
              <summary>
                Application context <span>Optional</span>
              </summary>
              <p>
                Embedded integrations capture their own page URL and version. Add the affected page
                here when submitting from the forge.
              </p>
              <div className="two-fields">
                <label className="field">
                  Page URL
                  <input
                    name="pageUrl"
                    type="url"
                    maxLength={2000}
                    placeholder="https://app.origin…"
                  />
                </label>
                <label className="field">
                  Software version
                  <input name="version" maxLength={80} placeholder="e.g. 2.4.1" />
                </label>
              </div>
            </details>
            {error && (
              <div className="alert danger" role="alert">
                {error}
              </div>
            )}
          </div>
          <div className="modal-footer">
            <span>
              <LockKeyhole size={13} /> Changes always need human approval.
            </span>
            <button type="submit" className="button primary" disabled={busy}>
              {busy ? <Loader2 className="spin" size={17} /> : <Flame size={17} />}{' '}
              {busy ? 'Submitting…' : 'Send to the forge'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
type DetailResponse = {
  request: RequestRecord;
  events: AuditEvent[];
  history: { revision: number; commit_sha: string; created_at: string }[];
};
function RequestDetail({
  id,
  review,
  session,
  navigate,
  notify,
}: {
  id: string;
  review: boolean;
  session: Session;
  navigate: (p: Route['page'], id?: string) => void;
  notify: (text: string) => void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');
  const [file, setFile] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState('');
  const [oldProposal, setOldProposal] = useState<Proposal | null>(null);
  const [oldRevision, setOldRevision] = useState<number | null>(null);
  const load = useCallback(async () => {
    const d = await api<DetailResponse>(`/requests/${id}`);
    setData(d);
    setFile((f) => f || d.request.proposal?.files[0]?.path || '');
  }, [id]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (review && session.actor.role !== 'user')
      void post(`/requests/${id}/review-start`).catch(() => {});
  }, [id, review, session.actor.role]);
  async function action(kind: string) {
    if (!data) return;
    setBusy(kind);
    setError('');
    const r = data.request;
    try {
      await post(
        `/requests/${id}/${kind}`,
        kind === 'approve'
          ? { commit: r.proposal?.commit, destination: r.destination, version: r.version }
          : kind === 'push' || kind === 'retry'
            ? {}
            : { comment, commit: r.proposal?.commit },
      );
      setComment('');
      await load();
      notify(
        kind === 'approve' || kind === 'push'
          ? 'Approval recorded. Publication completed.'
          : kind === 'revise'
            ? 'Revision requested. The forge is back at work.'
            : kind === 'reject'
              ? 'Request rejected.'
              : kind === 'retry'
                ? 'Coding job queued again.'
                : 'Comment added.',
      );
      if (kind === 'revise') navigate('detail', id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
      await load();
    } finally {
      setBusy('');
    }
  }
  if (!data)
    return (
      <div className="loading-section">
        {error ? <div className="alert danger">{error}</div> : <Loader2 className="spin" />}
      </div>
    );
  const r = data.request;
  const p = oldProposal || r.proposal;
  const selected = p?.files.find((f) => f.path === file) || p?.files[0];
  const canReview = session.actor.role === 'admin';
  const checksPassed =
    !!r.proposal?.checks.length && r.proposal.checks.every((c) => c.exitCode === 0);
  const canAct =
    canReview && r.status === 'Awaiting approval' && !r.approved_at && oldRevision === null;
  async function selectRevision(value: string) {
    setError('');
    if (value === 'current') {
      setOldRevision(null);
      setOldProposal(null);
      return;
    }
    try {
      const rev = Number(value);
      const proposal = await api<Proposal>(`/requests/${id}/proposals/${rev}`);
      setOldRevision(rev);
      setOldProposal(proposal);
      setFile(proposal.files[0]?.path || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load revision.');
    }
  }
  return (
    <>
      <button className="back-link" onClick={() => navigate('requests')}>
        <ArrowLeft size={15} /> All requests
      </button>
      <div className="request-heading">
        <div>
          <div className="request-heading-meta">
            <span className="mono">{r.id}</span>
            <span className="type-label">{r.type}</span>
            <Badge status={r.status} />
          </div>
          <h1>{r.title}</h1>
          <p>
            {r.application}
            <span>·</span> Submitted {dateTime(r.created_at)}
            <span>·</span> Revision {r.revision + 1}
          </p>
        </div>
        {!review && r.proposal && (
          <button className="button primary" onClick={() => navigate('review', r.id)}>
            <FileCode2 size={17} />
            {r.status === 'Awaiting approval' ? 'Review proposal' : 'View code changes'}
          </button>
        )}
        {review && (
          <button className="button secondary" onClick={() => navigate('detail', r.id)}>
            <MessageSquare size={16} /> Request details
          </button>
        )}
      </div>
      {error && (
        <div className="alert danger" role="alert">
          <TriangleAlert size={17} />
          {error}
        </div>
      )}
      {review && p ? (
        <>
          <div className="review-summary panel">
            <div>
              <div className="eyebrow">
                {oldRevision === null
                  ? 'IMPLEMENTATION SUMMARY'
                  : `HISTORICAL REVISION ${oldRevision + 1}`}
              </div>
              <h3>{p.summary}</h3>
              <div className="review-meta">
                <span>
                  <GitBranch size={14} />
                  <code>{p.commit.slice(0, 12)}</code>
                </span>
                <span>
                  <FileCode2 size={14} />
                  {p.files.length} files changed
                </span>
                <span>
                  <CheckCircle2 size={14} />
                  {p.checks.filter((c) => c.exitCode === 0).length}/{p.checks.length} checks passed
                </span>
              </div>
            </div>
            <select
              aria-label="Review revision"
              value={oldRevision === null ? 'current' : oldRevision}
              onChange={(e) => void selectRevision(e.target.value)}
            >
              <option value="current">Current · revision {r.revision + 1}</option>
              {data.history
                .filter((h) => h.revision !== r.revision)
                .map((h) => (
                  <option key={h.revision} value={h.revision}>
                    Revision {h.revision + 1} · {h.commit_sha.slice(0, 7)}
                  </option>
                ))}
            </select>
          </div>
          <div className="review-grid">
            <aside className="review-sidebar">
              <section className="panel file-panel">
                <div className="section-heading">
                  <h3>Changed files</h3>
                  <span className="count">{p.files.length}</span>
                </div>
                {p.files.map((f) => (
                  <button
                    key={f.path}
                    className={`file-button ${selected?.path === f.path ? 'active' : ''}`}
                    onClick={() => setFile(f.path)}
                  >
                    <FileCode2 size={16} />
                    <span>{f.path}</span>
                    <b className={f.deleted ? 'deleted' : 'added'}>
                      {f.deleted ? 'D' : f.before ? 'M' : 'A'}
                    </b>
                  </button>
                ))}
              </section>
              <section className="panel validation-panel">
                <div className="section-heading">
                  <h3>Validation</h3>
                  <ShieldCheck size={16} />
                </div>
                {p.checks.map((c, i) => (
                  <details className="check-result" key={i}>
                    <summary>
                      {c.exitCode === 0 ? (
                        <CheckCircle2 className="green-text" size={16} />
                      ) : (
                        <XCircle className="red-text" size={16} />
                      )}
                      <span>{c.command}</span>
                      <ChevronDown size={13} />
                    </summary>
                    <pre>{c.output}</pre>
                    <small>
                      Exit {c.exitCode} · {duration(c.durationMs)}
                    </small>
                  </details>
                ))}
              </section>
              <section className="panel limitations">
                <h3>Review notes</h3>
                {p.limitations.length ? (
                  p.limitations.map((l, i) => (
                    <p key={i}>
                      <TriangleAlert size={14} />
                      {l}
                    </p>
                  ))
                ) : (
                  <p>
                    <Check size={14} /> No unresolved limitations reported.
                  </p>
                )}
              </section>
            </aside>
            <div className="diff-panel panel">
              <div className="diff-header">
                <IconLabel icon={<FileCode2 size={16} />}>{selected?.path}</IconLabel>
                <span className="diff-legend">
                  <b>+{selected?.after.split('\n').length ?? 0}</b>
                  <i>−{selected?.before ? selected.before.split('\n').length : 0}</i>
                </span>
                <DownloadDiff
                  diff={p.diff}
                  filename={`${r.id}-r${oldRevision ?? r.revision}.patch`}
                />
              </div>
              <DiffView diff={p.diff} file={selected?.path || ''} />
            </div>
          </div>
          <section className="panel original-request">
            <div className="section-heading">
              <h3>Original request</h3>
              <MessageSquare size={16} />
            </div>
            <p>{r.feedback.description}</p>
            <div className="two-fields">
              <div>
                <h4>Expected behavior</h4>
                <p>{r.feedback.expected}</p>
              </div>
              {r.feedback.actual && (
                <div>
                  <h4>Actual behavior</h4>
                  <p>{r.feedback.actual}</p>
                </div>
              )}
            </div>
          </section>
          <section className="panel review-decision">
            <div className="decision-top">
              <div>
                <div className="eyebrow">THE HUMAN CHECKPOINT</div>
                <h2>
                  {r.status === 'Pushed'
                    ? 'A thoughtful change, approved.'
                    : r.status === 'Rejected'
                      ? 'This proposal was rejected.'
                      : r.approved_at
                        ? 'Approval is recorded.'
                        : 'Your code. Your call.'}
                </h2>
                <p>
                  {r.status === 'Pushed'
                    ? 'The approved commit is on its own branch with a pull request.'
                    : r.approved_at
                      ? `Approved by ${r.approved_by}. Retry publication if the publisher failed.`
                      : 'Approval is bound to the exact commit and repository destination below.'}
                </p>
              </div>
              <div className="approval-lock">
                <ShieldCheck size={27} />
              </div>
            </div>
            <div className="approval-destination">
              <GitBranch size={15} />
              <code>{r.destination}</code>
              <span>·</span>
              <code>{r.proposal?.commit.slice(0, 12)}</code>
            </div>
            {r.status === 'Pushed' && r.pr_url && (
              <a className="button primary" href={r.pr_url} target="_blank" rel="noreferrer">
                Open pull request <ArrowUpRight size={15} />
              </a>
            )}
            {canAct ? (
              <>
                <label className="field">
                  Reviewer comment{' '}
                  <span className="subtle">Required for revisions or rejection</span>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={3}
                    maxLength={8000}
                    placeholder="What should be adjusted? Add context for the next revision…"
                  />
                </label>
                <div className="decision-actions">
                  <div>
                    <button
                      className="button reject"
                      onClick={() => void action('reject')}
                      disabled={!!busy || comment.trim().length < 5}
                    >
                      <X size={15} /> Reject
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => void action('revise')}
                      disabled={!!busy || comment.trim().length < 5}
                    >
                      <MessageSquare size={15} /> Request revisions
                    </button>
                  </div>
                  <button
                    className="button primary"
                    onClick={() => void action('approve')}
                    disabled={!!busy || !checksPassed}
                  >
                    {busy === 'approve' ? (
                      <Loader2 className="spin" size={17} />
                    ) : (
                      <ShieldCheck size={17} />
                    )}{' '}
                    Approve and push
                    <ArrowRight size={16} />
                  </button>
                </div>
                {!checksPassed && (
                  <p className="red-text">
                    Required validation failures must be resolved before approval.
                  </p>
                )}
              </>
            ) : r.approved_at && !r.pushed_at && canReview ? (
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() => void action('push')}
              >
                Retry approved publication <ArrowRight size={16} />
              </button>
            ) : (
              !canReview && (
                <div className="alert">
                  <LockKeyhole size={16} /> Only administrators can approve, reject or request
                  changes.
                </div>
              )
            )}
            {oldRevision !== null && (
              <div className="alert">
                You are viewing a previous revision. Select the current revision to take action.
              </div>
            )}
          </section>
          <Comments events={data.events} />
        </>
      ) : review ? (
        <Empty title="The forge is still working">
          The diff will appear here when an implementation is ready for review.
        </Empty>
      ) : (
        <>
          <div className="request-tabs">
            {[
              { key: 'overview', label: 'Overview' },
              { key: 'logs', label: 'Execution log' },
              { key: 'history', label: 'Revision history' },
            ].map((t) => (
              <button
                key={t.key}
                className={tab === t.key ? 'active' : ''}
                onClick={() => setTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="detail-columns">
            <div>
              {tab === 'overview' ? (
                <>
                  <section className="panel request-description">
                    <div className="section-heading">
                      <h3>The feedback</h3>
                      <TypeIcon type={r.type} />
                    </div>
                    <p>{r.feedback.description}</p>
                    {r.feedback.steps && (
                      <>
                        <h4>STEPS TO REPRODUCE</h4>
                        <p>{r.feedback.steps}</p>
                      </>
                    )}
                    <div className="two-fields">
                      {r.feedback.actual && (
                        <div>
                          <h4>ACTUAL BEHAVIOR</h4>
                          <p>{r.feedback.actual}</p>
                        </div>
                      )}
                      <div>
                        <h4>EXPECTED BEHAVIOR</h4>
                        <p>{r.feedback.expected}</p>
                      </div>
                    </div>
                    {(r.feedback.pageUrl || r.feedback.version) && (
                      <div className="context">
                        <span>Application context</span>
                        {r.feedback.pageUrl && <code>{r.feedback.pageUrl}</code>}
                        {r.feedback.version && <span>Version {r.feedback.version}</span>}
                      </div>
                    )}
                  </section>
                  {r.proposal && (
                    <section className="panel implementation">
                      <div className="section-heading">
                        <h3>From the forge</h3>
                        <Flame size={18} />
                      </div>
                      <p>{r.proposal.summary}</p>
                      <ol className="plan-list">
                        {r.proposal.plan.map((s, i) => (
                          <li key={i}>
                            <span>{i + 1}</span>
                            {s}
                          </li>
                        ))}
                      </ol>
                      <div className="implementation-bottom">
                        <span>
                          <FileCode2 size={15} />
                          {r.proposal.files.length} files changed
                        </span>
                        <span>
                          <CheckCircle2 size={15} />
                          {r.proposal.checks.filter((c) => c.exitCode === 0).length}/
                          {r.proposal.checks.length} checks passed
                        </span>
                        <button className="text-button" onClick={() => navigate('review', r.id)}>
                          Review changes <ArrowRight size={15} />
                        </button>
                      </div>
                    </section>
                  )}
                  <Comments events={data.events} />
                  {canReview && (
                    <section className="panel comment-form">
                      <label className="field">
                        Add a reviewer comment
                        <textarea
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          rows={3}
                          maxLength={8000}
                          placeholder="Leave a note for the team…"
                        />
                      </label>
                      <button
                        className="button secondary"
                        disabled={!!busy || !comment.trim()}
                        onClick={() => void action('comment')}
                      >
                        Post comment <ArrowRight size={14} />
                      </button>
                    </section>
                  )}
                </>
              ) : tab === 'logs' ? (
                <section className="panel logs-panel">
                  <div className="section-heading">
                    <h3>Execution log</h3>
                    <Terminal size={17} />
                  </div>
                  {data.events.map((e) => (
                    <div className="log-entry" key={e.id}>
                      <div>
                        <span>{dateTime(e.created_at)}</span>
                        <b>{e.kind}</b>
                        <small>{e.actor}</small>
                      </div>
                      <p>{e.message}</p>
                      {e.data_json && <pre>{JSON.stringify(JSON.parse(e.data_json), null, 2)}</pre>}
                    </div>
                  ))}
                </section>
              ) : (
                <section className="panel history-panel">
                  <div className="section-heading">
                    <h3>Revision history</h3>
                    <GitBranch size={17} />
                  </div>
                  {data.history.length ? (
                    data.history.map((h) => (
                      <button
                        className="history-row"
                        key={h.revision}
                        onClick={() => {
                          navigate('review', id);
                        }}
                      >
                        <span className="revision-number">{h.revision + 1}</span>
                        <span>
                          <strong>Revision {h.revision + 1}</strong>
                          <small>
                            {dateTime(h.created_at)} · <code>{h.commit_sha.slice(0, 12)}</code>
                          </small>
                        </span>
                        <ArrowUpRight size={17} />
                      </button>
                    ))
                  ) : (
                    <Empty title="No revisions yet">
                      The first proposal will be recorded here when it’s ready.
                    </Empty>
                  )}
                </section>
              )}
            </div>
            <aside>
              <section className="panel progress-panel">
                <div className="section-heading">
                  <h3>Request journey</h3>
                  <Activity size={16} />
                </div>
                <ol className="timeline">
                  {data.events
                    .filter((e) => statuses.includes(e.kind as Status))
                    .map((e, i, a) => (
                      <li key={e.id} className={i === a.length - 1 ? 'current' : 'done'}>
                        <span className="timeline-dot">
                          {i < a.length - 1 ? (
                            <Check size={11} />
                          ) : ['Failed', 'Rejected'].includes(e.kind) ? (
                            <X size={11} />
                          ) : (
                            <span />
                          )}
                        </span>
                        <strong>{e.kind}</strong>
                        <small>{dateTime(e.created_at)}</small>
                        <p>{e.message}</p>
                      </li>
                    ))}
                </ol>
                {!['Awaiting approval', 'Pushed', 'Failed', 'Rejected'].includes(r.status) && (
                  <div className="forging">
                    {r.status === 'Submitted' &&
                    data.events.some((e) => e.kind === 'Waiting for setup') &&
                    !data.events.some((e) => e.kind === 'Job queued') ? (
                      <>
                        <ShieldCheck size={16} />
                        Saved — waiting for workspace setup
                      </>
                    ) : (
                      <>
                        <Loader2 className="spin" size={16} /> Hephaestus is working…
                      </>
                    )}
                  </div>
                )}
                {r.status === 'Failed' && canReview && (
                  <button
                    className="button secondary"
                    disabled={!!busy}
                    onClick={() => void action('retry')}
                  >
                    Retry implementation <ArrowRight size={15} />
                  </button>
                )}
              </section>
              <section className="human-note">
                <ShieldCheck size={23} />
                <h3>Human at the helm.</h3>
                <p>
                  Hephaestus can propose a change. Only an administrator can send it to the
                  repository.
                </p>
              </section>
            </aside>
          </div>
        </>
      )}
    </>
  );
}
function parseDiff(diff: string, file: string) {
  const sections = diff.split(/(?=diff --git )/);
  const chunk = sections.find((s) => s.startsWith(`diff --git a/${file} b/${file}\n`)) || diff;
  let oldLine = 0,
    newLine = 0;
  return chunk.split('\n').map((line) => {
    let type = 'context',
      a = '',
      b = '';
    if (line.startsWith('@@')) {
      type = 'hunk';
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)/);
      if (match) {
        oldLine = Number(match[1]) - 1;
        newLine = Number(match[2]) - 1;
      }
    } else if (
      ['diff ', 'index ', '---', '+++', 'new file', 'deleted file'].some((prefix) =>
        line.startsWith(prefix),
      )
    )
      type = 'meta';
    else if (line.startsWith('+')) {
      type = 'insert';
      b = String(++newLine);
    } else if (line.startsWith('-')) {
      type = 'remove';
      a = String(++oldLine);
    } else if (line) {
      a = String(++oldLine);
      b = String(++newLine);
    }
    return { line, type, a, b };
  });
}
function DownloadDiff({ diff, filename }: { diff: string; filename: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([diff], { type: 'text/plain' }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [diff]);
  return (
    <a className="text-button" href={url} download={filename}>
      Download diff <ArrowDown size={13} />
    </a>
  );
}
function DiffView({ diff, file }: { diff: string; file: string }) {
  return (
    <div className="diff-code" role="region" tabIndex={0} aria-label={`Code diff for ${file}`}>
      <table>
        <tbody>
          {parseDiff(diff, file).map(({ line, type, a, b }, i) => {
            return (
              <tr key={i} className={type}>
                <td className="line-num">{a}</td>
                <td className="line-num">{b}</td>
                <td className="code-line">
                  <pre>{line || ' '}</pre>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function Comments({ events }: { events: AuditEvent[] }) {
  const comments = events.filter((e) =>
    ['Comment', 'Changes requested', 'Rejected', 'Approved'].includes(e.kind),
  );
  if (!comments.length) return null;
  return (
    <section className="panel comments-panel">
      <div className="section-heading">
        <h3>Review conversation</h3>
        <MessageSquare size={17} />
      </div>
      {comments.map((e) => (
        <div className="comment" key={e.id}>
          <span className="avatar small">{e.actor[0].toUpperCase()}</span>
          <div>
            <strong>{e.actor}</strong>
            <small>
              {e.kind} · {dateTime(e.created_at)}
            </small>
            <p>{e.message}</p>
          </div>
        </div>
      ))}
    </section>
  );
}
async function logOutAdmin() {
  await api('/admin/session', { method: 'DELETE' });
  window.location.replace('/#/dashboard');
  window.location.reload();
}
function AdminAccess({
  session,
  onSession,
  onSaved,
}: {
  session: Session;
  onSession: (s: Session) => void;
  onSaved: (message: string) => void;
}) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function open(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/admin/session', { key });
      setKey('');
      onSession(await api<Session>('/me'));
      onSaved('Administrator controls enabled.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open admin controls.');
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    setBusy(true);
    try {
      await logOutAdmin();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not close admin controls.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel admin-access">
      <div>
        <ShieldCheck size={23} />
        <h3>
          {session.actor.role === 'admin'
            ? 'Administrator controls enabled'
            : 'Public feedback. Protected publishing.'}
        </h3>
        <p>
          {session.actor.role === 'admin'
            ? 'You can configure the workspace, review proposals, approve and push code.'
            : 'Anyone can submit and track feedback without an account. Only an administrator can approve and push repository changes.'}
        </p>
      </div>
      {session.actor.role === 'admin' ? (
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={() => void close()}
        >
          Log out <LogOut size={15} />
        </button>
      ) : (
        <form onSubmit={open}>
          <label className="field">
            Administrator access key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              required
              maxLength={256}
              placeholder="Enter your workspace admin key"
            />
          </label>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <LockKeyhole size={16} />} Open admin
            controls
          </button>
        </form>
      )}
      {error && (
        <div className="alert danger" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
function SettingsPage({
  session,
  onSaved,
  onSession,
}: {
  session: Session;
  onSaved: (message: string) => void;
  onSession: (s: Session) => void;
}) {
  const [data, setData] = useState<{
    settings: Settings;
    integrations: Record<string, string | boolean>;
  } | null>(null);
  const [tab, setTab] = useState('repository');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ settings: Settings; integrations: Record<string, string | boolean> }>('/settings')
      .then(setData)
      .catch((e) => setError(e.message));
  }, [session.actor.role]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      await api('/settings', { method: 'PUT', body: JSON.stringify(data.settings) });
      onSaved('Workspace settings saved. Existing proposals retain their original destination.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <div className="loading-section">{error || <Loader2 className="spin" />}</div>;
  const s = data.settings;
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setData((d) => (d ? { ...d, settings: { ...d.settings, [key]: value } } : d));
  }
  return (
    <>
      <PageHeading
        eyebrow="SET UP YOUR WORKSPACE"
        title="Settings"
        subtitle="Connect the repository. Choose the model. Keep the right people in control."
      />
      <AdminAccess session={session} onSession={onSession} onSaved={onSaved} />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {[
            { key: 'repository', label: 'Repository', icon: <GitBranch size={17} /> },
            { key: 'model', label: 'Coding model', icon: <Sparkles size={17} /> },
            { key: 'permissions', label: 'Admin & access', icon: <ShieldCheck size={17} /> },
            { key: 'integrations', label: 'Integrations', icon: <Command size={17} /> },
          ].map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? 'active' : ''}
              onClick={() => setTab(t.key)}
            >
              {t.icon}
              {t.label}
              <ChevronRight size={14} />
            </button>
          ))}
        </nav>
        <form className="settings-main" onSubmit={save}>
          {error && (
            <div className="alert danger" role="alert">
              {error}
            </div>
          )}
          {tab === 'repository' && (
            <section className="panel settings-card">
              <div className="settings-section-icon">
                <GitBranch size={22} />
              </div>
              <h2>A home for your code.</h2>
              <p>
                Proposals are prepared in isolation. An approved commit goes to a dedicated branch
                and a pull request.
              </p>
              <label className="field">
                GitHub repository
                <input
                  placeholder="organization/repository"
                  value={s.repository}
                  onChange={(e) => update('repository', e.target.value)}
                />
                <small>
                  Use the owner/repository format. Credentials are configured as Worker secrets.
                </small>
              </label>
              <label className="field">
                Base branch
                <input
                  required
                  value={s.baseBranch}
                  onChange={(e) => update('baseBranch', e.target.value)}
                />
              </label>
              <label className="field">
                ORIGIN applications
                <textarea
                  rows={3}
                  value={s.applications.join('\n')}
                  onChange={(e) => update('applications', e.target.value.split('\n'))}
                />
                <small>One application name per line.</small>
              </label>
              <div className="alert">
                <LockKeyhole size={16} />
                <span>
                  Branch pattern: <code>hephaestus/hep-&#123;request-id&#125;</code>
                  <br />
                  Merging and deployment remain separate actions.
                </span>
              </div>
            </section>
          )}
          {tab === 'model' && (
            <section className="panel settings-card">
              <div className="settings-section-icon">
                <Sparkles size={22} />
              </div>
              <h2>The intelligence in the forge.</h2>
              <p>
                Use an OpenAI-compatible coding model through the trusted runner broker. Credentials
                never enter the browser or test container.
              </p>
              <label className="field">
                Model provider
                <select value={s.provider} onChange={() => {}}>
                  <option value="openai-compatible">OpenAI-compatible API</option>
                </select>
              </label>
              <label className="field">
                Coding model
                <input required value={s.model} onChange={(e) => update('model', e.target.value)} />
                <small>Must be available at the runner’s configured MODEL_BASE_URL.</small>
              </label>
              <div className="two-fields">
                <label className="field">
                  Maximum revisions
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={s.maxRevisions}
                    onChange={(e) => update('maxRevisions', Number(e.target.value))}
                  />
                </label>
                <label className="field">
                  Job timeout (seconds)
                  <input
                    type="number"
                    min={30}
                    max={600}
                    value={s.timeoutSeconds}
                    onChange={(e) => update('timeoutSeconds', Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="field">
                Required validation commands
                <textarea
                  rows={4}
                  value={s.checks.join('\n')}
                  onChange={(e) => update('checks', e.target.value.split('\n'))}
                />
                <small>
                  One command per line. These execute inside the isolated container. Every check
                  must pass before approval.
                </small>
              </label>
            </section>
          )}
          {tab === 'permissions' && (
            <section className="panel settings-card">
              <div className="settings-section-icon">
                <ShieldCheck size={22} />
              </div>
              <h2>Public feedback. Admin decisions.</h2>
              <p>Anyone can submit feedback and follow their own requests without an account.</p>
              <div className="alert">
                <ShieldCheck size={18} />
                <span>
                  <strong>Administrators</strong> review proposals, request revisions, approve and
                  push exact reviewed commits, and configure the workspace.
                </span>
              </div>
              <div className="alert">
                <MessageSquare size={18} />
                <span>
                  <strong>Public contributors</strong> submit feedback and track it privately in the
                  same browser. Approval and publishing are unavailable to visitors.
                </span>
              </div>
              <div className="alert">
                <LockKeyhole size={18} />
                <span>
                  Administrator controls use the workspace access key. Sessions expire after eight
                  hours; closing admin controls revokes the session. Rotating the key revokes
                  existing admin access.
                </span>
              </div>
            </section>
          )}
          {tab === 'integrations' && (
            <>
              <section className="panel settings-card">
                <div className="settings-section-icon">
                  <Command size={22} />
                </div>
                <h2>Bring the forge to your software.</h2>
                <p>
                  Public feedback is open to everyone. The following connections enable repository
                  coding and publishing.
                </p>
                {[
                  {
                    key: 'repository',
                    label: 'GitHub repository',
                    detail: s.repository || 'Choose a repository in Repository settings.',
                  },
                  {
                    key: 'runner',
                    label: 'Isolated coding runner',
                    detail: 'RUNNER_URL + RUNNER_TOKEN · broker with Docker isolation',
                  },
                  {
                    key: 'publisher',
                    label: 'GitHub publisher',
                    detail: 'GITHUB_WRITE_TOKEN · Contents and Pull requests write permissions',
                  },
                  {
                    key: 'administrator',
                    label: 'Administrator access',
                    detail: 'Public feedback is open; approval and publishing are admin-only.',
                  },
                ].map((i) => (
                  <div className="integration-row" key={i.key}>
                    <span className="integration-icon">
                      {i.key === 'repository' ? (
                        <GitBranch size={20} />
                      ) : i.key === 'runner' ? (
                        <Terminal size={20} />
                      ) : i.key === 'publisher' ? (
                        <GitPullRequest size={20} />
                      ) : (
                        <ShieldCheck size={20} />
                      )}
                    </span>
                    <div>
                      <strong>{i.label}</strong>
                      <small>{i.detail}</small>
                    </div>
                    <span
                      className={`connection-state ${data.integrations[i.key] === true || data.integrations[i.key] === 'cloudflare-access' ? 'connected' : ''}`}
                    >
                      {data.integrations[i.key] === true ||
                      data.integrations[i.key] === 'cloudflare-access'
                        ? 'Connected'
                        : 'Setup required'}
                    </span>
                  </div>
                ))}
                <div className="alert">
                  <Code2 size={17} />
                  <span>
                    Feedback is saved immediately. Coding starts when the repository and runner are
                    connected. Model credentials belong on the runner; publishing credentials belong
                    on the Worker.
                  </span>
                </div>
              </section>
              <section className="panel settings-card">
                <h3>Authenticated feedback API</h3>
                <p>
                  Call from your ORIGIN application backend with a submission-only token. Never
                  expose this token in client-side code.
                </p>
                <pre className="integration-code">
                  {
                    'POST /api/requests\nAuthorization: Bearer <FEEDBACK_API_TOKEN>\nContent-Type: application/json\n\n{\n  "type": "bug",\n  "title": "Search results do not update",\n  "application": "ORIGIN CRM",\n  "description": "The search keeps showing old results.",\n  "steps": "Open contacts, enter a search, clear it.",\n  "actual": "The old results remain.",\n  "expected": "Show all contacts when search is cleared.",\n  "pageUrl": "https://crm.origin.example/contacts",\n  "version": "2.4.1"\n}'
                  }
                </pre>
                <p>
                  A reusable, accessible feedback button is available at{' '}
                  <a href="/feedback.js" target="_blank" rel="noreferrer">
                    /feedback.js <ExternalLink size={12} />
                  </a>
                  . It captures the page URL and supplied version, then calls your authenticated
                  backend proxy.
                </p>
              </section>
            </>
          )}
          {tab !== 'integrations' && (
            <div className="settings-actions">
              <span>
                <LockKeyhole size={13} />{' '}
                {session.actor.role === 'admin'
                  ? 'Only administrators can change settings.'
                  : 'Settings are read-only for your role.'}
              </span>
              <button
                type="submit"
                className="button primary"
                disabled={busy || session.actor.role !== 'admin'}
              >
                {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />} Save changes
              </button>
            </div>
          )}
        </form>
      </div>
    </>
  );
}
