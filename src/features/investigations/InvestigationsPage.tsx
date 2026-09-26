import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

export function InvestigationsPage() {
  useDocumentTitle('Investigations');

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Case management</p>
        <h1>Investigations</h1>
        <p className="page-description">Track coordinated response work and findings.</p>
      </header>
      <p className="empty-state">
        No investigations have been opened. Start by reviewing the{' '}
        <Link to="/alerts">alert queue</Link>.
      </p>
    </section>
  );
}
