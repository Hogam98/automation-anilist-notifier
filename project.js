const ANILIST_ENDPOINT = "https://graphql.anilist.co";
const ACTIVITY_LIMIT = 50;
const ACTIVITY_MIN_AGE_MINUTES = 30;
const POLL_DELAY_MS = 500;
const MESSAGE_SEND_DELAY_MS = 1500;
const FIXED_WIDTH_SPACER = `\n${"\u2800".repeat(30)}\u200D`;

const ANILIST_PROFILE_COLORS = {
  blue: 0x3db4f2,
  purple: 0xc063ff,
  pink: 0xfc9dd6,
  orange: 0xef881a,
  red: 0xe13333,
  green: 0x4cca51,
  gray: 0x677b94
};

const DISCORD_CHANNELS = [
  {
    name: "AniList",
    channelIdSecret: "ANILIST_CHANNEL_ID",
    webhookIdSecret: "ANILIST_WEBHOOK_ID",
    webhookTokenSecret: "ANILIST_WEBHOOK_TOKEN"
  }
];

const ANILIST_USERS = [
  { username: "Hogam98", language: "French" },
  { username: "Sakuraa09", language: "French" },
  { username: "Aledes", language: "Spanish" }
];

const USER_QUERY = `
  query ($name: String) {
    User(name: $name) {
      id
    }
  }
`;

const ACTIVITIES_QUERY = `
  query ($userId: Int, $perPage: Int) {
    Page(page: 1, perPage: $perPage) {
      activities(userId: $userId, type: MEDIA_LIST, sort: ID_DESC) {
        ... on ListActivity {
          id
          status
          progress
          createdAt
          user {
            siteUrl
            avatar {
              large
            }
            options {
              profileColor
            }
          }
          media {
            title {
              romaji
              english
            }
            coverImage {
              large
            }
            siteUrl
          }
        }
      }
    }
  }
`;

const PROGRESS_TEMPLATES = {
  French: {
    "watched episode": ["a vu l'épisode", "a vu les épisodes", "de"],
    "rewatched episode": ["a revu l'épisode", "a revu les épisodes", "de"],
    "read chapter": ["a lu le chapitre", "a lu les chapitres", "de"],
    "reread chapter": ["a relu le chapitre", "a relu les chapitres", "de"]
  },
  Spanish: {
    "watched episode": ["vio el episodio", "vio los episodios", "de"],
    "rewatched episode": ["volvió a ver el episodio", "volvió a ver los episodios", "de"],
    "read chapter": ["leyó el capítulo", "leyó los capítulos", "de"],
    "reread chapter": ["releyó el capítulo", "releyó los capítulos", "de"]
  },
  English: {
    "watched episode": ["watched episode", "watched episodes", "of"],
    "rewatched episode": ["rewatched episode", "rewatched episodes", "of"],
    "read chapter": ["read chapter", "read chapters", "of"],
    "reread chapter": ["reread chapter", "reread chapters", "of"]
  }
};

const STATUS_ACTIONS = {
  French: {
    "completed": "a terminé",
    "plans to watch": "a ajouté à sa liste",
    "plans to read": "a ajouté à sa liste",
    "dropped": "a abandonné",
    "paused": "a mis en pause",
    "rewatching": "a recommencé",
    "rereading": "a recommencé",
    "repeating": "a recommencé",
    "_fallback": "a mis à jour"
  },
  Spanish: {
    "completed": "completó",
    "plans to watch": "añadió a su lista",
    "plans to read": "añadió a su lista",
    "dropped": "abandonó",
    "paused": "pausó",
    "rewatching": "volvió a empezar",
    "rereading": "volvió a leer",
    "repeating": "volvió a empezar",
    "_fallback": "actualizó"
  },
  English: {
    "completed": "completed",
    "plans to watch": "plans to watch",
    "plans to read": "plans to read",
    "dropped": "dropped",
    "paused": "paused",
    "rewatching": "rewatching",
    "rereading": "rereading",
    "repeating": "repeating",
    "_fallback": "updated"
  }
};

async function queryAniList(context, query, variables) {
  const maxRetries = 4;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(ANILIST_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ query, variables })
      });

      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfterSec = response.status === 429
          ? Number(response.headers.get("retry-after"))
          : NaN;
        const waitMs = !Number.isNaN(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : 2000 * attempt;

        await context.sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`AniList HTTP error (${response.status}): ${await response.text()}`);
      }

      const parsed = await response.json();
      if (parsed.errors?.length) {
        throw new Error(`AniList GraphQL error: ${JSON.stringify(parsed.errors)}`);
      }

      return parsed;
    } catch (e) {
      if (attempt >= maxRetries) {
        throw e;
      }
      await context.sleep(2000 * attempt);
    }
  }
}

async function fetchLatestDiscordMessage(context, channelId) {
  const botToken = context.secrets.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error('Missing required secret "DISCORD_BOT_TOKEN".');
  }

  return context.gateway.getJson(
    `/discord/api/v10/channels/${channelId}/messages?limit=1`,
    {
      "Authorization": `Bot ${botToken}`,
      "User-Agent": "DiscordBot (https://discord.com, 1.0)"
    }
  );
}

async function sendWebhookEmbed(context, channelConfig, userProfile, embed) {
  const webhookId = context.secrets[channelConfig.webhookIdSecret];
  const webhookToken = context.secrets[channelConfig.webhookTokenSecret];
  if (!webhookId || !webhookToken) {
    throw new Error(`Missing required webhook secrets ("${channelConfig.webhookIdSecret}", "${channelConfig.webhookTokenSecret}") for channel "${channelConfig.name}".`);
  }

  const payload = {
    username: userProfile.name,
    embeds: [embed]
  };

  if (userProfile.avatarUrl?.trim()) {
    payload.avatar_url = userProfile.avatarUrl.trim();
  }

  await context.gateway.postJson(
    `/discord/api/v10/webhooks/${webhookId}/${webhookToken}`,
    payload
  );
}

function resolveProfileColor(profileColor) {
  const raw = String(profileColor || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }
  if (ANILIST_PROFILE_COLORS[raw] !== undefined) {
    return ANILIST_PROFILE_COLORS[raw];
  }
  const hexMatch = raw.match(/^#?([0-9a-f]{6})$/);
  return hexMatch ? parseInt(hexMatch[1], 16) : null;
}

function formatLocalizedDescription(userProfile, status, progress, mediaTitle) {
  const lang = STATUS_ACTIONS[userProfile.language] ? userProfile.language : "French";
  const normalizedStatus = String(status || "").toLowerCase().trim();
  const progressStr = progress ? String(progress).trim() : "";
  const isRange = /[-–,&]/.test(progressStr);
  const userLink = `**[${userProfile.name}](${userProfile.siteUrl})**`;
  const titleBold = `**${mediaTitle}**`;

  const progressTemplate = PROGRESS_TEMPLATES[lang][normalizedStatus];
  if (progressTemplate) {
    const [singular, plural, preposition] = progressTemplate;
    return `${userLink} ${isRange ? plural : singular} ${progressStr} ${preposition} ${titleBold}`;
  }

  const action = STATUS_ACTIONS[lang][normalizedStatus] || status || STATUS_ACTIONS[lang]._fallback;
  return `${userLink} ${action} ${titleBold}`;
}

function buildActivityEmbed(userProfile, activity) {
  const media = activity.media;
  const mediaTitle = media.title?.romaji || media.title?.english || "Unknown Title";

  const embed = {
    title: mediaTitle,
    url: media.siteUrl,
    description: `${formatLocalizedDescription(userProfile, activity.status, activity.progress, mediaTitle)}${FIXED_WIDTH_SPACER}`
  };

  if (userProfile.color !== null) {
    embed.color = userProfile.color;
  }

  if (media.coverImage?.large) {
    embed.thumbnail = { url: media.coverImage.large };
  }

  return embed;
}

function buildUserProfile(userConfig, activityUser) {
  return {
    name: userConfig.username,
    language: userConfig.language,
    avatarUrl: activityUser?.avatar?.large || "",
    siteUrl: activityUser?.siteUrl || `https://anilist.co/user/${encodeURIComponent(userConfig.username)}`,
    color: resolveProfileColor(activityUser?.options?.profileColor)
  };
}

function isActivityMature(activity, nowSec) {
  const createdAt = Number(activity?.createdAt || 0);
  return !createdAt || (nowSec - createdAt) >= ACTIVITY_MIN_AGE_MINUTES * 60;
}

async function getUserId(context, username) {
  const normalizedUsername = username.toLowerCase();
  const cachedId = Number(context.state.get("ANILIST_USER_ID", normalizedUsername) || 0);
  if (cachedId > 0) {
    return cachedId;
  }

  const response = await queryAniList(context, USER_QUERY, { name: username });
  const userId = Number(response?.data?.User?.id || 0);
  if (!userId) {
    throw new Error(`Unable to fetch AniList user ID for ${username}`);
  }

  context.state.set("ANILIST_USER_ID", normalizedUsername, userId);
  return userId;
}

async function collectUserActivities(context, userConfig, isChannelEmpty) {
  const userId = await getUserId(context, userConfig.username);
  const normalizedUsername = userConfig.username.toLowerCase();
  const storedLastId = isChannelEmpty
    ? 0
    : Number(context.state.get("LAST_ACTIVITY_ID", normalizedUsername) || 0);

  const response = await queryAniList(context, ACTIVITIES_QUERY, {
    userId,
    perPage: ACTIVITY_LIMIT
  });

  const nowSec = Math.floor(Date.now() / 1000);
  const validActivities = (response?.data?.Page?.activities || []).filter(
    act => act?.id && act?.media && isActivityMature(act, nowSec)
  );

  if (validActivities.length === 0) {
    return [];
  }

  if (storedLastId === 0) {
    return [{
      userProfile: buildUserProfile(userConfig, validActivities[0].user),
      activity: validActivities[0]
    }];
  }

  return validActivities
    .filter(act => Number(act.id) > storedLastId)
    .map(activity => ({
      userProfile: buildUserProfile(userConfig, activity.user),
      activity
    }));
}

async function processChannel(context, channelConfig) {
  const channelId = context.secrets[channelConfig.channelIdSecret];
  if (!channelId) {
    throw new Error(`Missing required secret "${channelConfig.channelIdSecret}" for channel "${channelConfig.name}".`);
  }

  const existingMessages = await fetchLatestDiscordMessage(context, channelId);
  const isChannelEmpty = !Array.isArray(existingMessages) || existingMessages.length === 0;
  const pendingQueue = [];

  for (let i = 0; i < ANILIST_USERS.length; i++) {
    try {
      const items = await collectUserActivities(context, ANILIST_USERS[i], isChannelEmpty);
      pendingQueue.push(...items);
    } catch (e) {
      console.warn(`[AniList] [User ${ANILIST_USERS[i].username}] Fetch failed (${e.message}).`);
    }

    if (i < ANILIST_USERS.length - 1) {
      await context.sleep(POLL_DELAY_MS);
    }
  }

  if (pendingQueue.length === 0) {
    console.log(`[AniList] [Channel ${channelConfig.name}] No new activities.`);
    return;
  }

  pendingQueue.sort((a, b) => {
    const timeDiff = Number(a.activity.createdAt || 0) - Number(b.activity.createdAt || 0);
    return timeDiff !== 0 ? timeDiff : Number(a.activity.id) - Number(b.activity.id);
  });

  for (let i = 0; i < pendingQueue.length; i++) {
    const { userProfile, activity } = pendingQueue[i];
    const embed = buildActivityEmbed(userProfile, activity);

    await sendWebhookEmbed(context, channelConfig, userProfile, embed);
    context.state.set("LAST_ACTIVITY_ID", userProfile.name.toLowerCase(), Number(activity.id));

    if (i < pendingQueue.length - 1) {
      await context.sleep(MESSAGE_SEND_DELAY_MS);
    }
  }

  console.log(`[AniList] [Channel ${channelConfig.name}] Sent ${pendingQueue.length} notification(s).`);
}

module.exports = async function (context) {
  for (const channelConfig of DISCORD_CHANNELS) {
    try {
      await processChannel(context, channelConfig);
    } catch (e) {
      console.warn(`[AniList] [Channel ${channelConfig.name}] Processing failed (${e.message}).`);
    }
  }
};
