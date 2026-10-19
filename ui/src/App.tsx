import React, { useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { CommandPalette, Empty, RunBar, Sidebar, Toasts } from './components';
import Dashboard from './pages/Dashboard';
import Office from './pages/Office';
import Activity from './pages/Activity';
import Timeline from './pages/Timeline';
import Tasks from './pages/Tasks';
import TaskDetail from './pages/TaskDetail';
import DodEditor from './pages/Dod';
import Errors from './pages/Errors';
import ErrorDetail from './pages/ErrorDetail';
import Approvals from './pages/Approvals';
import Agents from './pages/Agents';
import Skills from './pages/Skills';
import Providers from './pages/Providers';
import Team from './pages/Team';
import Project from './pages/Project';
import Routing from './pages/Routing';
import Workflow from './pages/Workflow';
import { Checkpoints, RepoTimeline } from './pages/History';
import { Compass } from 'lucide-react';

export default function App() {
  const [nav, setNav] = useState(false);
  const [palette, setPalette] = useState(false);
  return (
    <div className="grain h-[100dvh] flex overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] btn btn-primary">Skip to content</a>
      <Sidebar open={nav} onClose={() => setNav(false)} />
      <div className="relative z-10 flex-1 min-w-0 flex flex-col">
        <RunBar onMenu={() => setNav(true)} onPalette={() => setPalette(true)} />
        <main id="main" className="flex-1 min-h-0 min-w-0 overflow-auto">
          <div className="mx-auto w-full max-w-[1320px] min-w-0 px-4 lg:px-8 py-6 lg:py-8">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/office" element={<Office />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/timeline" element={<Timeline />} />
              <Route path="/team" element={<Team />} />
              <Route path="/project" element={<Project />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/tasks/:id" element={<TaskDetail />} />
              <Route path="/dod/:runId" element={<DodEditor />} />
              <Route path="/errors" element={<Errors />} />
              <Route path="/errors/:id" element={<ErrorDetail />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/agents" element={<Agents />} />
              <Route path="/skills" element={<Skills />} />
              <Route path="/providers" element={<Providers />} />
              <Route path="/routing" element={<Routing />} />
              <Route path="/workflow" element={<Workflow />} />
              <Route path="/checkpoints" element={<Checkpoints />} />
              <Route path="/repo-timeline" element={<RepoTimeline />} />
              <Route path="*" element={
                <Empty icon={Compass} title="Page not found" text="That address doesn't match any screen in the Office.">
                  <Link to="/" className="btn">Back to dashboard</Link>
                </Empty>
              } />
            </Routes>
          </div>
        </main>
      </div>
      <CommandPalette open={palette} setOpen={setPalette} />
      <Toasts />
    </div>
  );
}
