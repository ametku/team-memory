export interface Fact {
  id: string;
  content: string;
  project: string | null;
  tags: string[];
  created_at: string;
  deleted_at: string | null;
}
