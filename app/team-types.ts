export type TeamPerson = {
  id: string;
  name: string;
};

export type TeamAssignmentDraft = {
  personId: string;
  role: string;
  serviceKey: string | null;
  serviceLabel: string | null;
};

export type TeamAssignment = TeamAssignmentDraft & {
  id: string;
  serverId: string;
  projectId: string;
  projectName: string;
  projectPath: string | null;
};

export type TeamData = {
  revision: number;
  people: TeamPerson[];
  assignments: TeamAssignment[];
};
