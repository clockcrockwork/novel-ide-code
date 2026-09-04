export type Bindings = {
  SESSIONS: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
};

export type Variables = {
  githubToken: string;
  login: string;
  sessionToken: string;
  authorizedRepos: string[];
  sessionRaw: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
