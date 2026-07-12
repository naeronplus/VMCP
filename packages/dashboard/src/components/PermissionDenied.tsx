export function PermissionDenied({
  resource,
  required,
}: {
  resource: string;
  required: string;
}) {
  return (
    <div className="panel">
      <h1 style={{ marginTop: 0 }}>Insufficient permissions</h1>
      <p className="muted">
        You do not have access to <strong>{resource}</strong>. Required role:{' '}
        <span className="badge info">{required}</span>
      </p>
    </div>
  );
}
