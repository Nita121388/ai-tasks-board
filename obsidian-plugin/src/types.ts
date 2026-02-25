export type BoardStatus = "Unassigned" | "Todo" | "Doing" | "Review" | "Done";

export type BoardTask = {
  uuid: string;
  title: string;
  status: BoardStatus;
  tags: string[];
  rawBlock: string;
  start: number;
  end: number;
};

export type BoardSection = {
  status: BoardStatus;
  headingStart: number;
  headingEnd: number;
  sectionStart: number;
  sectionEnd: number;
  tasks: BoardTask[];
};

export type ParsedBoard = {
  content: string;
  autoStart: number;
  autoEnd: number;
  sections: Map<BoardStatus, BoardSection>;
};

