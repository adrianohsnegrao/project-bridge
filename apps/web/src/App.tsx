import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { Approval, AuditEvent, McpInfo, Overview, Page, Project, ProjectSummary } from "./types";

const statusLabels = {
  active: "Em andamento",
  at_risk: "Requer atenção",
  completed: "Concluído",
  todo: "A fazer",
  in_progress: "Em andamento",
  blocked: "Bloqueada",
  done: "Concluída",
  pending: "Pendente",
  approved: "Aprovada",
  rejected: "Rejeitada",
};

function dateLabel(value: string | null): string {
  if (!value) return "Sem data";
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

export default function App() {
  const [page, setPage] = useState<Page>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [mcpInfo, setMcpInfo] = useState<McpInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tutorialOpen, setTutorialOpen] = useState(() => localStorage.getItem("project-bridge-tutorial") !== "done");

  const refresh = async () => {
    setError("");
    try {
      const [nextOverview, nextProjects, nextApprovals, nextAudit, nextMcpInfo] = await Promise.all([
        api.overview(), api.projects(), api.approvals(), api.audit(), api.mcpInfo(),
      ]);
      setOverview(nextOverview);
      setProjects(nextProjects);
      setApprovals(nextApprovals);
      setAudit(nextAudit);
      setMcpInfo(nextMcpInfo);
      if (nextProjects[0]) setProject(await api.project(nextProjects[0].id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Não foi possível carregar a central.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const navigate = (nextPage: Page) => {
    setPage(nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Ir para o conteúdo</a>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true">PB</span><div><strong>Central de Projetos</strong><small>Project Bridge</small></div></div>
        <button className="quiet-button" onClick={() => setTutorialOpen(true)}>Como funciona</button>
      </header>

      <aside className="sidebar">
        <nav aria-label="Navegação principal">
          <NavButton active={page === "overview"} label="Visão geral" symbol="⌂" onClick={() => navigate("overview")} />
          <NavButton active={page === "projects"} label="Projetos" symbol="▤" onClick={() => navigate("projects")} />
          <NavButton active={page === "approvals"} label="Aprovações" symbol="✓" count={overview?.pending_approvals} onClick={() => navigate("approvals")} />
          <NavButton active={page === "activity"} label="Integrações" symbol="↔" onClick={() => navigate("activity")} />
        </nav>
        <div className="sidebar-note"><span className="status-dot" /> <strong>Servidor local</strong><small>MCP e API disponíveis</small></div>
      </aside>

      <main id="main-content" className="content" tabIndex={-1}>
        {error && <div className="error-banner" role="alert"><strong>Não foi possível carregar os dados.</strong><span>{error}</span><button onClick={() => void refresh()}>Tentar novamente</button></div>}
        {loading ? <Loading /> : (
          <>
            {page === "overview" && overview && <OverviewPage overview={overview} project={project} audit={audit} onNavigate={navigate} />}
            {page === "projects" && <ProjectsPage projects={projects} project={project} onSelect={async (id) => setProject(await api.project(id))} />}
            {page === "approvals" && <ApprovalsPage approvals={approvals} onDecision={async (id, decision, note) => { await api.decideApproval(id, decision, note); await refresh(); }} />}
            {page === "activity" && mcpInfo && <ActivityPage info={mcpInfo} audit={audit} />}
          </>
        )}
      </main>

      {tutorialOpen && <Tutorial onClose={() => { localStorage.setItem("project-bridge-tutorial", "done"); setTutorialOpen(false); }} onOpenApprovals={() => { localStorage.setItem("project-bridge-tutorial", "done"); setTutorialOpen(false); navigate("approvals"); }} />}
    </div>
  );
}

function NavButton({ active, label, symbol, count, onClick }: { active: boolean; label: string; symbol: string; count?: number; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} aria-current={active ? "page" : undefined} onClick={onClick}><span aria-hidden="true">{symbol}</span>{label}{count ? <b>{count}</b> : null}</button>;
}

function PageHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-heading"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}

function OverviewPage({ overview, project, audit, onNavigate }: { overview: Overview; project: Project | null; audit: AuditEvent[]; onNavigate: (page: Page) => void }) {
  return <>
    <PageHeading eyebrow="VISÃO GERAL" title="O trabalho importante, em um só lugar." description="Acompanhe projetos e revise solicitações feitas pelas integrações antes que qualquer mudança aconteça." />
    <section className="metric-grid" aria-label="Indicadores">
      <Metric label="Projetos" value={overview.projects} note={`${overview.projects_at_risk} requer atenção`} tone="blue" />
      <Metric label="Aprovações pendentes" value={overview.pending_approvals} note="aguardando uma pessoa" tone="orange" />
      <Metric label="Impedimentos abertos" value={overview.open_blockers} note="precisam de acompanhamento" tone="red" />
      <Metric label="Operações auditadas" value={overview.audited_operations} note="registradas localmente" tone="green" />
    </section>
    <div className="overview-grid">
      {project && <section className="panel featured-project"><div className="section-title"><div><span>EM DESTAQUE</span><h2>{project.name}</h2></div><StatusPill status={project.status} /></div><p>{project.summary}</p><div className="progress-heading"><span>Progresso geral</span><strong>{project.progress}%</strong></div><div className="progress-track"><span style={{ width: `${project.progress}%` }} /></div><div className="project-facts"><div><small>Responsável</small><strong>{project.owner}</strong></div><div><small>Data alvo</small><strong>{dateLabel(project.target_date)}</strong></div><div><small>Impedimentos</small><strong>{project.blockers.length} abertos</strong></div></div><button className="primary-button" onClick={() => onNavigate("projects")}>Abrir projeto</button></section>}
      <section className="panel attention-panel"><div className="section-title"><div><span>PRECISA DE VOCÊ</span><h2>Revisão humana</h2></div></div><div className="approval-callout"><span className="callout-icon">✓</span><div><strong>{overview.pending_approvals} solicitação pendente</strong><p>Uma integração propôs uma ação. Nada foi alterado até sua decisão.</p></div></div><button className="secondary-button" onClick={() => onNavigate("approvals")}>Revisar solicitações</button></section>
    </div>
    <section className="panel recent-panel"><div className="section-title"><div><span>ATIVIDADE RECENTE</span><h2>O que as integrações fizeram</h2></div><button className="link-button" onClick={() => onNavigate("activity")}>Ver auditoria completa</button></div><AuditList events={audit.slice(0, 3)} /></section>
  </>;
}

function Metric({ label, value, note, tone }: { label: string; value: number; note: string; tone: string }) {
  return <article className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}

function ProjectsPage({ projects, project, onSelect }: { projects: ProjectSummary[]; project: Project | null; onSelect: (id: string) => void }) {
  const counts = useMemo(() => project ? {
    pending: project.tasks.filter((task) => task.status !== "done").length,
    decisions: project.decisions.filter((decision) => decision.status === "pending").length,
  } : { pending: 0, decisions: 0 }, [project]);
  return <>
    <PageHeading eyebrow="PROJETOS" title="Contexto organizado para pessoas e integrações." description="As mesmas informações visíveis aqui podem ser consultadas de forma estruturada por clientes MCP autorizados." />
    <label className="project-selector">Projeto selecionado<select value={project?.id ?? ""} onChange={(event) => onSelect(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {project && <>
      <section className="project-hero panel"><div><StatusPill status={project.status} /><h2>{project.name}</h2><p>{project.objective}</p></div><div className="progress-circle" style={{ "--progress": `${project.progress * 3.6}deg` } as React.CSSProperties}><span>{project.progress}%<small>concluído</small></span></div></section>
      <section className="project-summary-strip"><div><small>Responsável</small><strong>{project.owner}</strong></div><div><small>Data alvo</small><strong>{dateLabel(project.target_date)}</strong></div><div><small>Tarefas abertas</small><strong>{counts.pending}</strong></div><div><small>Decisões pendentes</small><strong>{counts.decisions}</strong></div></section>
      <div className="project-columns">
        <section className="panel"><div className="section-title"><div><span>EXECUÇÃO</span><h2>Tarefas</h2></div></div><div className="item-list">{project.tasks.map((task) => <article className="work-item" key={task.id}><StatusPill status={task.status} /><div><strong>{task.title}</strong><small>{task.assignee ?? "Sem responsável"} · {dateLabel(task.due_date)}{task.source === "mcp" ? " · criada após aprovação" : ""}</small></div><span className={`priority ${task.priority}`}>{task.priority === "high" ? "Alta" : task.priority === "medium" ? "Média" : "Baixa"}</span></article>)}</div></section>
        <section className="panel"><div className="section-title"><div><span>RISCOS</span><h2>Impedimentos</h2></div></div><div className="item-list">{project.blockers.map((blocker) => <article className="blocker-item" key={blocker.id}><span>!</span><div><strong>{blocker.title}</strong><p>{blocker.impact}</p><small>Responsável: {blocker.owner ?? "não definido"}</small></div></article>)}</div></section>
      </div>
      <div className="project-columns">
        <section className="panel"><div className="section-title"><div><span>GOVERNANÇA</span><h2>Decisões</h2></div></div><div className="decision-list">{project.decisions.map((decision) => <article key={decision.id}><div><StatusPill status={decision.status} /><strong>{decision.title}</strong></div><p>{decision.decision}</p><small>{decision.context}</small></article>)}</div></section>
        <section className="panel"><div className="section-title"><div><span>REFERÊNCIAS</span><h2>Documentos</h2></div></div><div className="document-list">{project.documents.map((document) => <article key={document.id}><span>▤</span><div><strong>{document.title}</strong><p>{document.summary}</p><small>{document.kind} · atualizado em {dateLabel(document.updated_at)}</small></div></article>)}</div></section>
      </div>
    </>}
  </>;
}

function ApprovalsPage({ approvals, onDecision }: { approvals: Approval[]; onDecision: (id: string, decision: "approved" | "rejected", note: string) => Promise<void> }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  const pending = approvals.filter((approval) => approval.status === "pending");
  const decided = approvals.filter((approval) => approval.status !== "pending");

  const decide = async (approval: Approval, decision: "approved" | "rejected") => {
    const note = notes[approval.id]?.trim();
    if (!note || note.length < 3) return;
    setWorking(approval.id);
    try { await onDecision(approval.id, decision, note); } finally { setWorking(null); }
  };

  return <>
    <PageHeading eyebrow="APROVAÇÕES" title="Nenhuma mudança acontece sem você." description="Integrações podem propor ações, mas somente uma decisão humana transforma a solicitação em uma alteração real." />
    <div className="safety-banner"><span>◎</span><div><strong>Limite de segurança ativo</strong><p>A ferramenta MCP <code>propose_task</code> cria somente uma solicitação. A tarefa ainda não existe.</p></div></div>
    <section aria-labelledby="pending-title"><div className="section-title page-section-title"><div><span>AGUARDANDO REVISÃO</span><h2 id="pending-title">Solicitações pendentes</h2></div><b className="count-badge">{pending.length}</b></div>{pending.length === 0 ? <EmptyState text="Nenhuma solicitação aguardando revisão." /> : pending.map((approval) => <article className="approval-card" key={approval.id}><header><div><span className="tool-label">Ferramenta · {approval.tool_name}</span><h3>{approval.arguments.title ?? approval.operation}</h3></div><StatusPill status={approval.status} /></header><div className="approval-grid"><div><small>Solicitado por</small><strong>{approval.requested_by}</strong></div><div><small>Projeto</small><strong>{approval.project_id === "atlas" ? "Projeto Atlas" : approval.project_id}</strong></div><div><small>Prioridade</small><strong>{approval.arguments.priority === "high" ? "Alta" : approval.arguments.priority ?? "—"}</strong></div><div><small>Prazo sugerido</small><strong>{dateLabel(approval.arguments.due_date ?? null)}</strong></div></div><div className="justification"><small>Justificativa registrada</small><p>{approval.justification}</p></div><details><summary>Ver contrato e chave idempotente</summary><dl><div><dt>Operação</dt><dd>{approval.operation}</dd></div><div><dt>Chave</dt><dd><code>{approval.idempotency_key}</code></dd></div><div><dt>Escopo exigido</dt><dd><code>tasks:propose</code></dd></div></dl></details><label className="review-note">Observação da decisão<textarea placeholder="Registre por que esta solicitação deve ou não prosseguir." value={notes[approval.id] ?? ""} onChange={(event) => setNotes({ ...notes, [approval.id]: event.target.value })} /></label><div className="approval-actions"><button className="reject-button" disabled={working === approval.id || (notes[approval.id]?.trim().length ?? 0) < 3} onClick={() => void decide(approval, "rejected")}>Rejeitar solicitação</button><button className="approve-button" disabled={working === approval.id || (notes[approval.id]?.trim().length ?? 0) < 3} onClick={() => void decide(approval, "approved")}>{working === approval.id ? "Registrando…" : "Aprovar e criar tarefa"}</button></div></article>)}</section>
    {decided.length > 0 && <section className="decided-section"><div className="section-title page-section-title"><div><span>HISTÓRICO</span><h2>Decisões anteriores</h2></div></div>{decided.map((approval) => <article className="decided-row" key={approval.id}><StatusPill status={approval.status} /><div><strong>{approval.arguments.title ?? approval.operation}</strong><small>{approval.requested_by} · {dateLabel(approval.decided_at)}</small></div><p>{approval.decision_note}</p></article>)}</section>}
  </>;
}

function ActivityPage({ info, audit }: { info: McpInfo; audit: AuditEvent[] }) {
  return <>
    <PageHeading eyebrow="INTEGRAÇÕES" title="Uma ponte controlada para clientes MCP." description="Consulte capacidades, contratos e cada operação realizada sem expor a experiência técnica ao usuário comum." />
    <section className="connection-card panel"><div className="connection-status"><span className="status-dot" /><div><strong>MCP disponível</strong><small>{info.transport} · SDK {info.version}</small></div></div><code>{info.endpoint}</code></section>
    <div className="integration-grid">
      <section className="panel capability-panel"><div className="section-title"><div><span>CAPACIDADES</span><h2>Tools</h2></div><b>{info.tools.length}</b></div>{info.tools.map((tool) => <div className="capability-row" key={tool}><code>{tool}</code><span>{tool === "propose_task" ? "exige aprovação" : "somente leitura"}</span></div>)}</section>
      <section className="panel capability-panel"><div className="section-title"><div><span>CONTEXTO</span><h2>Resources e Prompt</h2></div></div>{info.resources.map((resource) => <div className="capability-row" key={resource}><code>{resource}</code><span>resource</span></div>)}{info.prompts.map((prompt) => <div className="capability-row" key={prompt}><code>{prompt}</code><span>prompt</span></div>)}</section>
    </div>
    <section className="panel scopes-panel"><div className="section-title"><div><span>PERMISSÕES</span><h2>Escopos mínimos</h2></div></div><p>Clientes HTTP sem configuração recebem apenas leitura. Propostas de tarefa exigem um escopo adicional explícito.</p><div className="scope-list">{info.default_scopes.map((scope) => <code key={scope}>{scope}</code>)}<code className="mutation-scope">{info.mutation_scope}</code></div></section>
    <section className="panel audit-panel"><div className="section-title"><div><span>AUDITORIA</span><h2>Trajetória das operações</h2></div><b>{audit.length} registros</b></div><AuditList events={audit} detailed /></section>
  </>;
}

function AuditList({ events, detailed = false }: { events: AuditEvent[]; detailed?: boolean }) {
  return <div className="audit-list">{events.map((event) => <article key={event.id}><span className={`audit-symbol ${event.status}`}>{event.status === "success" ? "↙" : event.status === "pending_approval" ? "…" : "✓"}</span><div><strong>{event.action.replaceAll("_", " ")}</strong><small>{event.client_name} · {new Date(event.created_at).toLocaleString("pt-BR")}</small></div><StatusPill status={event.status} /><span className="duration">{detailed ? `${event.duration_ms.toFixed(1)} ms` : ""}</span></article>)}</div>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${status}`}>{statusLabels[status as keyof typeof statusLabels] ?? status.replaceAll("_", " ")}</span>;
}

function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>✓</span><p>{text}</p></div>; }
function Loading() { return <div className="loading" role="status"><span /><p>Organizando seus projetos…</p></div>; }

function Tutorial({ onClose, onOpenApprovals }: { onClose: () => void; onOpenApprovals: () => void }) {
  const [step, setStep] = useState(0);
  const steps = [
    { symbol: "PB", eyebrow: "BEM-VINDO", title: "Conheça a Central de Projetos", text: "Você acompanha o trabalho normalmente. Por trás da interface, o Project Bridge oferece contexto estruturado para clientes compatíveis com MCP." },
    { symbol: "↔", eyebrow: "CONTEXTO CONTROLADO", title: "Integrações consultam somente o necessário", text: "Projetos, decisões e impedimentos são disponibilizados por Resources e Tools com contratos definidos. O cliente não recebe acesso direto ao banco de dados." },
    { symbol: "✓", eyebrow: "APROVAÇÃO HUMANA", title: "Propor não significa executar", text: "Quando uma integração propõe uma tarefa, a solicitação aparece na caixa de aprovações. Nada muda antes de uma pessoa revisar e decidir." },
    { symbol: "◎", eyebrow: "AUDITORIA", title: "Cada operação deixa evidências", text: "Cliente, ferramenta, escopo, duração, chave idempotente e resultado ficam registrados para inspeção." },
  ];
  const current = steps[step];
  return <div className="modal-backdrop" role="presentation"><section className="tutorial-modal" role="dialog" aria-modal="true" aria-labelledby="tutorial-title"><button className="modal-close" aria-label="Fechar tutorial" onClick={onClose}>×</button><div className="tutorial-symbol">{current.symbol}</div><span className="tutorial-eyebrow">{current.eyebrow}</span><h2 id="tutorial-title">{current.title}</h2><p>{current.text}</p><div className="tutorial-dots" aria-label={`Etapa ${step + 1} de ${steps.length}`}>{steps.map((_, index) => <span key={index} className={index === step ? "active" : ""} />)}</div><div className="tutorial-actions">{step > 0 && <button className="quiet-button" onClick={() => setStep(step - 1)}>Voltar</button>}{step < steps.length - 1 ? <button className="primary-button" onClick={() => setStep(step + 1)}>Continuar</button> : <button className="primary-button" onClick={onOpenApprovals}>Ver uma aprovação de exemplo</button>}</div></section></div>;
}
