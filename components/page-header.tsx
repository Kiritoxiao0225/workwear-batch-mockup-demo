import type { ReactNode } from 'react';

/**
 * The row every page opens with: what the page is, one line on what to do here, and its actions.
 * Tabs for the page's sub-views go in `children`. The compact form is for one-screen workspaces.
 */
export function PageHeader({ title, description, actions, compact = false, children }: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className={compact ? 'page-header page-header--compact' : 'page-header'}>
      <div className="page-header__row">
        <div className="page-header__text">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** Sub-views of one page, drawn as a tab strip under its header. */
export function PageTabs<K extends string>({ tabs, value, onChange, label }: {
  tabs: readonly (readonly [K, ReactNode])[];
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  return (
    <nav className="page-tabs" role="tablist" aria-label={label}>
      {tabs.map(([key, name]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} className={value === key ? 'active' : undefined} onClick={() => onChange(key)}>
          {name}
        </button>
      ))}
    </nav>
  );
}
