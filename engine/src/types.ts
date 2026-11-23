/** The nine standard categories. Order matters only for display. */
export const CATEGORIES = ["PTS", "REB", "AST", "STL", "BLK", "3PM", "FG%", "FT%", "TO"] as const;
export type Category = (typeof CATEGORIES)[number];

/** Per-game season averages for one player. Matches what the API computes (AVG per game, not totals). */
export interface SeasonAverages {
  pts: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  fg3m: number;
  fg_pct: number;
  ft_pct: number;
  turnovers: number;
  /** Average field-goal attempts per game: the "volume" behind FG%. */
  fga: number;
  /** Average free-throw attempts per game: the "volume" behind FT%. */
  fta: number;
  /**
   * Average made field goals and made free throws per game (snapshot additions, optional so older files still load).
   * A team's FG% / FT% is made / attempted; fg_pct / ft_pct (mean of per-game percentages) understate players with
   * games without attempts. Used by the matchup simulation.
   */
  fgm?: number;
  ftm?: number;
}

/** League means and standard deviations for one season (a row of nba_data.league_pg_stats_by_season). */
export interface LeagueBaselines {
  means: {
    m_pts: number; m_reb: number; m_ast: number; m_stl: number; m_blk: number;
    m_fg3m: number; m_fg_pct: number; m_ft_pct: number; m_tov: number;
  };
  stds: {
    s_pts: number; s_reb: number; s_ast: number; s_stl: number; s_blk: number;
    s_fg3m: number; s_tov: number;
    /** Std of (pct - league mean pct) x attempts: the denominator for the shooting-percentage "impact" z. */
    s_fg_imp: number; s_ft_imp: number;
  };
}

/** Category weights. 1 = counts fully, 0 = not scored / punted. Omitted categories use the default. */
export type CategoryWeights = Partial<Record<Category, number>>;

export interface FantasyValueOptions {
  /** Per-category weights, e.g. a league that does not score TO, or a user punting FT%. */
  weights?: CategoryWeights;
  /** Shorthand for weights.TO. Ignored if weights.TO is given. */
  toWeight?: number;
}

export interface CategoryValue {
  /**
   * Standardised score where HIGHER IS ALWAYS BETTER, in every category. For turnovers the sign is already
   * flipped: a player who turns the ball over a lot has a NEGATIVE TO score.
   */
  z: number;
  weight: number;
  /** What this category adds to the total: weight x z. */
  contribution: number;
}

export interface FantasyValue {
  total: number;
  categories: Record<Category, CategoryValue>;
  engine_version: string;
}

/** One player's season, as the API computes it. `gp` and `mpg` decide who is in the rosterable pool. */
export interface PlayerSeason {
  player_id: number;
  name: string;
  gp: number;
  mpg: number;
  averages: SeasonAverages;
}

/** How much evidence stands behind a player's estimate. */
export type Confidence = "high" | "medium" | "low" | "none";
/** Team strength in one category, relative to the simulated league. */
export type Band = "elite" | "strong" | "neutral" | "weak";

/** One season of one player. */
export interface SeasonLine {
  season: string; // "2025-26"
  gp: number;
  mpg: number;
  averages: SeasonAverages;
}
export interface PlayerHistory {
  player_id: number | null;
  name: string;
  seasons: SeasonLine[];
}
/** A player's estimated per-game averages, blended from recent seasons. */
export interface Estimate {
  /** null = no usable NBA history (rookie, or no games in the last three seasons). */
  averages: SeasonAverages | null;
  confidence: Confidence;
  /** The weighted number of games behind the estimate. */
  effectiveGames: number;
  seasonsUsed: string[];
  /** True when the player has no completed-season history and the estimate comes from this season alone (D10, option C). */
  currentSeasonOnly?: boolean;
}
export interface LeagueSettings {
  teams: number;
  /** Roster spots that count toward the totals (IL slots are not included). */
  rosterSpots: number;
}
