interface PlaceholderPageProps {
  title: string;
  description: string;
}

// Generic "not built yet" screen body. Centralizes the placeholder markup so
// each route stub file (src/routes/*-page.tsx) stays a one-line wrapper;
// T5-T13 each delete their page's usage of this and replace it with the real
// screen content.
export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{description}</p>
    </div>
  );
}
