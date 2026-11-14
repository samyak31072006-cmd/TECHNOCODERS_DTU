import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ArrowRight, MapPin, ShieldAlert } from 'lucide-react';

import { useSystem } from '../context/SessionContext';
import { useToast } from '../components/ui/toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { StatusBadge } from '../components/ui/badge';
import { EmptyState } from '../components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { PageHeader, SectionHeading } from '../components/PageHeader';
import EmergencyModal from '../components/EmergencyModal';
import { fmt } from '../lib/format';

function severityTone(severity) {
  const key = String(severity || '').toUpperCase();
  if (key === 'CRITICAL' || key === 'HIGH') return 'danger';
  if (key === 'MODERATE' || key === 'MEDIUM') return 'warning';
  return 'neutral';
}

function buildChecks({ cameraConnected, engineStatus }) {
  return [
    { label: 'Camera API', ready: Boolean(navigator.mediaDevices?.getUserMedia) },
    { label: 'Landmark models', ready: engineStatus.state === 'ready' },
    { label: 'Camera stream', ready: cameraConnected },
    { label: 'Geolocation API', ready: Boolean(navigator.geolocation) },
    { label: 'Dispatch provider', ready: false, note: 'none configured - simulated' },
  ];
}

export default function EmergencyPage() {
  const {
    activeIncident,
    incidents,
    demoMode,
    cameraConnected,
    engineStatus,
    location,
    locationError,
    requestLocation,
    simulateIncident,
    cancelIncident,
    requestHelp,
    resolveIncident,
  } = useSystem();
  const { pushToast } = useToast();
  const [selected, setSelected] = useState(null);
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState(null);

  const simulate = () => {
    const incident = simulateIncident();
    setSelected(incident);
    setOpen(true);
    pushToast({
      tone: 'warn',
      title: 'Simulated incident created',
      message: 'Fixture sensor values were scored. No dispatch occurred.',
    });
  };

  const act = (fn, message) => {
    if (!selected) return;
    fn(selected.id);
    pushToast({ tone: 'signal', title: message });
    setOpen(false);
    setSelected(null);
  };

  const openIncident = (incident) => {
    setSelected(incident);
    setOpen(true);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Emergency"
        description="Incident scoring, driver decisions and the dispatch record. Everything is client-side and dispatch is always simulated."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setChecks(buildChecks({ cameraConnected, engineStatus }))}>
              <Activity className="size-4" />
              Self-check
            </Button>
            <Button size="sm" onClick={simulate}>
              <ShieldAlert className="size-4" />
              Simulate incident
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Active incident</CardTitle>
            <CardDescription>Held in this browser until it is resolved</CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            {activeIncident ? (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={severityTone(activeIncident.severity)}>{activeIncident.severity}</StatusBadge>
                  <StatusBadge tone="neutral">{String(activeIncident.status || '').replace(/_/g, ' ')}</StatusBadge>
                  {activeIncident.is_simulated && <StatusBadge tone="warning">Simulated</StatusBadge>}
                  <span className="font-mono text-[12px] tabular text-muted-foreground">
                    {activeIncident.incident_id} · {activeIncident.timestamp}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-3">
                  <div>
                    <p className="text-[12px] text-muted-foreground">Confidence</p>
                    <p className="font-semibold tabular">{fmt(activeIncident.confidence, 0)}%</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-muted-foreground">Driver condition</p>
                    <p className="font-semibold">{activeIncident.driver_condition || 'Unknown'}</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-muted-foreground">Location</p>
                    <p className="font-semibold">
                      {activeIncident.location ? 'Browser geolocation' : 'Not available'}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => openIncident(activeIncident)}>
                    View details
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => act(cancelIncident, 'Incident cancelled')}>
                    I'm safe
                  </Button>
                  <Button size="sm" onClick={() => act(requestHelp, 'Help requested')}>
                    Request help
                  </Button>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={ShieldAlert}
                title="No active incident"
                description="An incident opens when the impact scorer crosses its threshold. This build has no accelerometer, so the only way to exercise the flow is the clearly labelled simulation above."
              />
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Location</CardTitle>
              <CardDescription>Only if you grant browser geolocation</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {location ? (
                <div className="text-[13px]">
                  <p className="font-mono text-[12px] tabular">
                    {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
                  </p>
                  <p className="text-[12px] text-muted-foreground">
                    Accuracy ±{Math.round(location.accuracy_m || 0)} m, captured by the browser
                  </p>
                  <a
                    href={`https://www.openstreetmap.org/?mlat=${location.latitude}&mlon=${location.longitude}#map=16/${location.latitude}/${location.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-block text-[12px] text-primary underline-offset-4 hover:underline"
                  >
                    Open in OpenStreetMap
                  </a>
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  No coordinates are held. Nothing is invented: if permission is denied, incidents carry no location.
                </p>
              )}
              {locationError && <p className="text-[12px] text-warning">{locationError}</p>}
              <Button variant="outline" size="sm" onClick={requestLocation}>
                <MapPin className="size-4" />
                {location ? 'Refresh location' : 'Use my location'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Contacts</CardTitle>
              <CardDescription>People the simulated gateway would notify</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-[13px] text-muted-foreground">
                Seeded rows are placeholders. Add a real contact before relying on the flow.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link to="/emergency/contacts">
                  Manage contacts
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {checks && (
        <Card>
          <CardHeader>
            <CardTitle>Browser self-check</CardTitle>
            <CardDescription>Read from this browser when you pressed the button</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-[13px]">
            {checks.map((check) => (
              <div key={check.label} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">{check.label}</span>
                <span className="font-medium">
                  {check.ready ? 'Ready' : check.note || 'Unavailable'}
                </span>
              </div>
            ))}
            <p className="pt-2 text-[12px] text-muted-foreground">
              Impact scoring needs an accelerometer, OBD reader and GPS; none is reachable from a browser. The simulation
              above uses fixture values and says so.
            </p>
          </CardContent>
        </Card>
      )}

      <section>
        <SectionHeading title="Incident history" description="Stored in this browser, capped at 20 records." />
        <Card>
          <CardContent className="pt-5">
            {incidents.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Incident</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead className="hidden sm:table-cell">Confidence</TableHead>
                    <TableHead className="hidden md:table-cell">Status</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {incidents.map((incident) => (
                    <TableRow key={incident.id}>
                      <TableCell className="font-mono text-[12px]">
                        {incident.incident_id}
                        {incident.is_simulated && <span className="ml-2 text-[11px] text-warning">sim</span>}
                      </TableCell>
                      <TableCell className="font-mono text-[12px] tabular text-muted-foreground">
                        {incident.timestamp}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={severityTone(incident.severity)}>{incident.severity}</StatusBadge>
                      </TableCell>
                      <TableCell className="hidden tabular sm:table-cell">{fmt(incident.confidence, 0)}%</TableCell>
                      <TableCell className="hidden text-[12px] text-muted-foreground md:table-cell">
                        {String(incident.status || '').replace(/_/g, ' ')}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[12px]"
                          onClick={() => openIncident(incident)}
                        >
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                title="No incidents recorded"
                description="Nothing has been scored in this browser. Use Simulate incident to exercise the flow."
              />
            )}
          </CardContent>
        </Card>
      </section>

      {demoMode && (
        <p className="text-[12px] text-muted-foreground">
          Demo mode is on: telemetry is synthesised in the browser, not measured from the camera.
        </p>
      )}

      <EmergencyModal
        open={open}
        onOpenChange={setOpen}
        incident={selected}
        busy={false}
        onCancel={() => act(cancelIncident, 'Incident cancelled')}
        onRequestHelp={() => act(requestHelp, 'Help requested')}
        onResolve={() => act(resolveIncident, 'Incident resolved')}
      />
    </div>
  );
}
