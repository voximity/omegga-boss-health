import OmeggaPlugin, { OL, PS, PC, ILogMinigame, OmeggaPlayer } from "omegga";

type Config = {
  ["boss-team-names"]: string[];
  ["interval"]: number;
  ["health-bar-size"]: number;
  ["middle-print"]: boolean;
  ["announce-timeout"]: number;
  ["announce-health-change"]: number;
  ["announce-require-time-and-health-change"]: boolean;
};
type Storage = {};

type Minigame = {
  ruleset: string;
  bossTeam: ILogMinigame["teams"][number];
  boss: {
    name: string | null;
    pawn: string | null;
    controller: string | null;
    health: [number, number] | null;
  };
  announce: { last: number; lastHealthFrac: number };
};

export default class Plugin implements OmeggaPlugin<Config, Storage> {
  omegga: OL;
  config: PC<Config>;
  store: PS<Storage>;
  bossTeamNames: string[];
  minis: Minigame[];

  constructor(omegga: OL, config: PC<Config>, store: PS<Storage>) {
    this.omegga = omegga;
    this.config = config;
    this.store = store;

    this.minis = [];
    this.bossTeamNames = config["boss-team-names"].map((s) =>
      s.trim().toLowerCase()
    );
  }

  async getPawn({ controller }) {
    const pawnRegExp = new RegExp(
      `(?<index>\\d+)\\) BP_PlayerController_C .+?PersistentLevel\\.${controller}\\.Pawn = (?:None|BP_FigureV2_C'.+?:PersistentLevel\\.(?<pawn>BP_FigureV2_C_\\d+)')?$`
    );
    this.omegga.writeln(`GetAll BP_PlayerController_C Pawn Name=${controller}`);
    const pawnMatch = await this.omegga.addWatcher(pawnRegExp, {
      timeoutDelay: 100,
    });
    return pawnMatch[0].groups.pawn;
  }

  async getPawnHealth(pawn: string): Promise<[number, number]> {
    const damageRegExp = new RegExp(
      `(?<index>\\d+)\\) BP_FigureV2_C .+?PersistentLevel\\.${pawn}\\.Damage = (?<damage>[\\d.-]+)$`
    );
    const damageLimitRegExp = new RegExp(
      `(?<index>\\d+)\\) BP_FigureV2_C .+?PersistentLevel\\.${pawn}\\.DamageLimit = (?<limit>[\\d.-]+)$`
    );

    this.omegga.writeln(`GetAll BP_FigureV2_C Damage Name=${pawn}`);
    const damageMatch = await this.omegga.addWatcher(damageRegExp, {
      timeoutDelay: 100,
    });

    this.omegga.writeln(`GetAll BP_FigureV2_C DamageLimit Name=${pawn}`);
    const damageLimitMatch = await this.omegga.addWatcher(damageLimitRegExp, {
      timeoutDelay: 100,
    });

    const maxHealth = Number(damageLimitMatch[0].groups.limit);
    const health = maxHealth - Number(damageMatch[0].groups.damage);

    return [health, maxHealth];
  }

  displayHealth(
    teamName: string,
    playerName: string,
    [health, maxHealth]: [number, number],
    toPlayers?: string[]
  ) {
    const frac = Math.max(0, health) / maxHealth;

    // display the preliminary info
    const info = `<color="c00"><b>${teamName} Health</></> <color="900">(${playerName})</>`;

    // display the healthbar
    const barLength = this.config["health-bar-size"];
    const healthSize = Math.round(frac * barLength);
    const message = `<color="aaa">[<color="0a0">${"=".repeat(
      healthSize
    )}</><color="a00">${"=".repeat(barLength - healthSize)}</>]</>${
      this.config["middle-print"] ? "<br>" : " "
    }<b>${Math.ceil(Math.max(0, health))}</><color="aaa">/</>${Math.ceil(
      maxHealth
    )}`;

    if (toPlayers) {
      for (const player of toPlayers)
        if (this.config["middle-print"])
          this.omegga.middlePrint(
            player,
            "<br>".repeat(4) + info + "<br>" + message
          );
        else {
          this.omegga.whisper(player, info);
          this.omegga.whisper(player, message);
        }
    } else {
      this.omegga.broadcast(info);
      this.omegga.broadcast(message);
    }
  }

  async loop() {
    const minigames = (await this.omegga.getMinigames()) ?? [];

    // get rid of old minis
    for (let i = this.minis.length - 1; i >= 0; i--) {
      if (!minigames.find((m) => m.ruleset === this.minis[i].ruleset)) {
        this.minis.splice(i, 1);
      }
    }

    // for each minigame
    for (const mg of minigames) {
      const bossTeam = mg.teams.find((t) =>
        this.bossTeamNames.includes(t.name.toLowerCase())
      );

      // ignore this minigame unless it has one of the boss team names
      if (!bossTeam) continue;

      // get our mini object for this minigame
      let mini = this.minis.find((m) => m.ruleset === mg.ruleset);
      if (!mini) {
        // we don't have our mini object, so we can make it
        mini = {
          ruleset: mg.ruleset,
          bossTeam,
          boss: { name: null, pawn: null, controller: null, health: null },
          announce: { last: 0, lastHealthFrac: 0 },
        };

        this.minis.push(mini);
      }

      // check if the controller still has a pawn
      if (mini.boss.pawn) {
        const pawn = await this.getPawn(mini.boss);

        // reset if they don't have a pawn anymore
        if (!pawn || pawn != mini.boss.pawn)
          mini.boss = {
            name: null,
            pawn: null,
            controller: null,
            health: null,
          };
      }

      if (!mini.boss.pawn) {
        // there is no boss pawn, either wait for one or set a new one

        // if there aren't any players on the team, just skip ahead
        if (bossTeam.members.length === 0) continue;

        // get the first member from the team that actually has a pawn
        let memberWithPawn: OmeggaPlayer;
        let bossPawn: string;
        for (const member of bossTeam.members) {
          const pawn = await this.getPawn(member);
          if (pawn) {
            memberWithPawn = member;
            bossPawn = pawn;
            break;
          }
        }

        // if no pawn was found, skip ahead
        if (!bossPawn) continue;

        // at this point we have a player and a pawn
        mini.boss.name = memberWithPawn.name;
        mini.boss.pawn = bossPawn;
        mini.boss.controller = memberWithPawn.controller;
      }

      // fetch the boss's health
      mini.boss.health = await this.getPawnHealth(mini.boss.pawn);

      // figure out whether or not we should announce this interval
      let shouldAnnounce = false;

      const now = Date.now();
      const healthFrac = mini.boss.health[0] / mini.boss.health[1];
      const timeoutPassed =
        now - mini.announce.last >= 1000 * this.config["announce-timeout"];
      const healthChangePassed =
        Math.abs(mini.announce.lastHealthFrac - healthFrac) >=
        this.config["announce-health-change"];

      if (this.config["announce-require-time-and-health-change"]) {
        // both time and health must be satisfied
        if (timeoutPassed && healthChangePassed) shouldAnnounce = true;
      } else {
        // either time or health can be satisfied
        if (timeoutPassed || healthChangePassed) shouldAnnounce = true;
      }

      if (shouldAnnounce) {
        // should announce here, adjust the announce params and announce it
        mini.announce.last = now;
        mini.announce.lastHealthFrac = healthFrac;

        this.displayHealth(
          mini.bossTeam.name,
          mini.boss.name,
          mini.boss.health,
          mg.members.map((m) => m.name)
        );
      }
    }
  }

  async init() {
    setInterval(this.loop.bind(this), this.config["interval"] ?? 1_000);
    return {};
  }

  async stop() {}
}
