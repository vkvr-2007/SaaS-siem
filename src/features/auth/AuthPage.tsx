import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

export function AuthPage() {
  useDocumentTitle('Sign in');
  const [notice, setNotice] = useState('');

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice('No identity provider is configured for this project yet.');
  }

  return (
    <section>
      <header className="page-heading">
        <p className="eyebrow">Account access</p>
        <h1>Sign in</h1>
        <p className="page-description">Authentication is not connected to an identity provider.</p>
      </header>
      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          Email
          <input autoComplete="username" name="email" required type="email" />
        </label>
        <label>
          Password
          <input autoComplete="current-password" name="password" required type="password" />
        </label>
        <Button type="submit">Continue</Button>
        {notice && (
          <p aria-live="polite" className="auth-notice">
            {notice}
          </p>
        )}
      </form>
    </section>
  );
}
