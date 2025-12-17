import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';

export function TimeoutPage(): JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-xl">Session timed out</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You were signed out due to inactivity. Please sign back in to continue.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => navigate('/login')}>Return to login</Button>
            <Button variant="ghost" onClick={() => navigate(-1)}>
              Go back
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
