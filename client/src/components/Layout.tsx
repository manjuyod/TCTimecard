import { Outlet } from 'react-router-dom';
import Logo from './Logo';

function Layout(): JSX.Element {
  return (
    <div className="app-shell">
      <div className="company-logo">
        <Logo />
      </div>

      <div className="container">
        <header className="main-header">
          <h1>Request for Time Off</h1>
          <p className="instructions">
            Please complete and return this form to your supervisor. You must submit requests for absences, other than
            sick leave, 14 days prior to the first day you will be absent.
          </p>
        </header>

        <div className="header-divider" />

        <div className="form-body">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

export default Layout;
