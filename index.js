const Discord = require('discord.js');
const Loki = require('lokijs');
const winston = require('winston');
const bot = new Discord.Client({autoReconnect: true});
const DEFAULT_REACT_THRESHOLD = 1;
const DEFAULT_FUN_POLICE = false;
const DEFAULT_ALLOW_SELFIES = false;
// const timeTillLate = 86400; // One day
const events = {
  MESSAGE_REACTION_ADD: 'messageReactionAdd',
  MESSAGE_REACTION_REMOVE: 'messageReactionRemove'
};
let initalised = false;
let fetched = false;
let db;

winston.configure({
  level: 'info',
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' })
  ],
  exceptionHandlers: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'exception.log' })
  ]
});

init(function (err) {
  if (err) {
    winston.error(err);
    process.exit(1);
  }
  winston.info('Ready to rock!');
});

bot.login(process.env.TOKEN);

bot.on('ready', function (event) {
  winston.info(`Logged in as ${bot.user.username} - ${bot.user.id}`);
  // Before we start, fetch all the users in our db to avoid explosions
  // Include those which are IN_PROGRESS OR null
  let allPosts = db.getCollection('scraps').chain().data();
  let userFetches = allPosts.map(post => bot.fetchUser(post.authorId).catch(err => err));
  Promise.all(userFetches)
    .then(results => {
      results.forEach(result => {
        if (result instanceof Error) winston.error(`Fetch error encountered: ${result}`);
      });
      winston.info('Fetch completed!');
      fetched = true;
    })
    .catch(err => winston.error(err));
  // If a post is IN_PROGRESS and never got unset, reset it to null
  const inProgressPosts = allPosts.filter(post => post.botMessageId === 'IN_PROGRESS');
  inProgressPosts.forEach(post => {
    // A bit misleading but it will do the job
    let messageInfo = db.getCollection('scraps').findOne({'botMessageId': post.botMessageId});
    messageInfo.botMessageId = null;
    db.saveDatabase();
  });

  /*
  // As long as the bot is online, the likes will be correct
  // However, when it goes offline, we may have missed something
  // Run this resync every once and a while just to make sure we're looking good ;)

  allPosts.forEach(post => {
    const guild = bot.guilds.get(post.guildId);
    const ch = guild.channels.find(channel => channel.name === 'scrapbook');
    ch.fetchMessage(post.botMessageId).then(bmsg => {
      // Calculate net likes

      // I don't know if this fetch actually needs to be in here
      let messageInfo = db.getCollection('scraps').findOne({'botMessageId': post.botMessageId});
      let reactions = bmsg.reactions;
      let likes = reactions.get('👍');
      let dislikes = reactions.get('👎');
      let netLikes = (likes ? likes.count : 0) - (dislikes ? dislikes.count : 0);
      messageInfo.likes = netLikes;
      db.saveDatabase();
    }).catch(err => winston.error(err));
  });

  // Similar working for user snapped

  allPosts.forEach(post => {
    const msgChannel = bot.channels.get(post.channelId);
    msgChannel.fetchMessage(post.originalMessageId).then(msg => {
      // Get proper user reaction count
      let reacts = msg.reactions;
      let snaps = reacts.get('📸');
      if (!snaps) return; // If nothing do nothing, need something
      snaps.fetchUsers().then(userCollect => {
        let messageInfo = db.getCollection('scraps').findOne({'originalMessageId': post.originalMessageId});
        messageInfo.snappedBy = Array.from(userCollect.keys());
        db.saveDatabase();
      });
    }).catch(err => winston.error(err));
  });

  // Some migration to keep for reference but to comment out
  allPosts.forEach(post => {
    const guild = bot.guilds.get(post.guildId);
    const ch = guild.channels.find(channel => channel.name === 'scrapbook');
    if (!post.botChannelId) {
      let messageInfo = db.getCollection('scraps').findOne({'originalMessageId': post.originalMessageId});
      messageInfo.botChannelId = ch.id;
      db.saveDatabase();
    }
  });
  */
});

bot.on('message', function (message) {
  // Handle commands
  if (!message.author.bot) {
    if (!fetched) return; // Don't run any commands if we haven't done a full fetch
    let guild = message.guild;
    if (!guild) return;
    let thisGuildInfo = getGuildInfo(guild);
    let command = message.content.match(/\S+/g) || [];
    if (command[0] !== bot.user.toString()) return;
    if (command[1]) {
      let scraps = db.getCollection('scraps');
      let lCommand = command[1].toLowerCase();
      if (['top', 'snaps', 'likes'].includes(lCommand) && thisGuildInfo.funPolice) {
        message.channel.send(';~;');
        return;
      }
      switch (lCommand) {
        case 'top':
          let results = scraps.chain().find({'botMessageId': {'$nin': [null, 'IN_PROGRESS']}});
          if (command[2]) {
            let userId = getUserFromMention(command[2]);
            let user = bot.users.get(userId) || isKnownUser(userId);
            if (user) {
              results = results.find({'authorId': {'$eq': userId}});
            } else {
              message.channel.send(`Sorry, I don't know someone called ${command[2]}. ` +
                `Make sure you are using a proper user mention! Don't worry about pinging them, I'm sure it'll be fine ;)`);
              return;
            }
          }
          results = results.sort((a, b) => a.likes === b.likes ? b.quoteOn - a.quoteOn : b.likes - a.likes).limit(3).data();
          let forText = command[2] ? `for ${command[2]}` : 'of all time';
          message.channel.send(`Here are the top 3 most popular snaps ${forText}. *ahem*`).then(msg => {
            sendEmbedList(results, message.channel, 1);
          });
          break;
        case 'snaps':
          let snappedUsers = groupByArray(scraps.chain().find({'botMessageId': {'$nin': [null, 'IN_PROGRESS']}}).data(), 'authorId');
          let snappedScores = snappedUsers.map(user => {
            return {user: getDisplayName(user.key, guild), score: user.values.length};
          });
          message.channel.send('', {embed: createScoreboard(snappedScores, 'Users most snapped', '📸')});
          break;
        case 'likes':
          let scoredUsers = groupByArray(scraps.chain().find({'botMessageId': {'$nin': [null, 'IN_PROGRESS']}}).data(), 'authorId');
          let scoredScores = scoredUsers.map(user => { // I really do crack myself up sometimes
            return {
              user: getDisplayName(user.key, guild),
              score: user.values.reduce(function (current, ele) {
                return current + ele.likes;
              }, 0)};
          });
          message.channel.send('', {embed: createScoreboard(scoredScores, 'Most liked users', '👍')});
          break;
        case 'export':
          // Let's go!
          if (command[2]) {
            // Check if user
            let userId = getUserFromMention(command[2]);
            let user = bot.users.get(getUserFromMention(userId)) || isKnownUser(userId);
            if (user) {
              // Ready to rock, try to parse...
              let state = 'EXPORT';
              let before = null;
              let after = null;
              let likes = null;
              let withUsers = [];
              let withoutUsers = [];
              let snapper = false;
              for (let i = 3; i < command.length; i++) {
                let com = command[i].toUpperCase();
                if (['WITH', 'WITHOUT', 'BEFORE', 'AFTER', 'LIKES'].includes(com)) {
                  state = com;
                } else if (com === 'SNAPPER') {
                  snapper = true;
                } else {
                  let mentionedUserId = getUserFromMention(command[i]);
                  let mentionedUser = bot.users.get(mentionedUserId) || isKnownUser(mentionedUserId);
                  switch (state) {
                    case 'EXPORT':
                      if (mentionedUser) {
                        message.channel.send(`Can't export multiple users at once! ` +
                          `I don't make the rules, I just think them up and write them down.`);
                      } else {
                        message.channel.send(`Sorry, if ${command[i]} is a command I don't know it. Maybe you need some help? uwu`);
                      }
                      return;
                    case 'WITH':
                    case 'WITHOUT':
                      if (mentionedUser) {
                        let arr = state === 'WITH' ? withUsers : withoutUsers;
                        arr.push(mentionedUserId);
                      } else {
                        message.channel.send(`Sorry, I don't know someone called ${command[i]}. ` +
                          `Make sure you are using a proper user mention! Don't worry about pinging them, I'm sure it'll be fine ;)`);
                        return;
                      }
                      break;
                    case 'BEFORE':
                    case 'AFTER':
                      let date = state === 'BEFORE' ? before : after;
                      if (date) {
                        message.channel.send(`You know that ${state} only takes one param, right? >w<`);
                        return;
                      } else {
                        let dateToParse = Date.parse(command[i]);
                        if (isNaN(dateToParse)) {
                          message.channel.send(`Sorry, I didn't understand the date ${command[i]}. Make sure you are using proper date like 2018-08-27!`);
                          return;
                        } else {
                          state === 'BEFORE' ? before = dateToParse : after = dateToParse;
                        }
                      }
                      break;
                    case 'LIKES':
                      let num = parseInt(command[i]);
                      if (likes || isNaN(num)) {
                        message.channel.send(`Sorry, I don't understand, what do you want the minimum number of likes to be? owo`);
                        return;
                      } else {
                        likes = num;
                      }
                      break;
                    default:
                      throw new Error(`Unrecognised state ${state}`);
                  }
                }
              }

              // We've made it this far with no errors, generate the export
              let dataset = scraps.chain().find({'botMessageId': {'$nin': [null, 'IN_PROGRESS']}});
              dataset = snapper ? dataset.find({'snappedBy': {'$contains': userId}}) : dataset.find({'authorId': {'$eq': userId}});
              if (withUsers.length > 0) dataset = dataset.find({'snappedBy': {'$containsAny': withUsers}});
              if (withoutUsers.length > 0) dataset = dataset.find({'snappedBy': {'$containsNone': withoutUsers}});
              if (before) dataset = dataset.find({'quoteOn': {'$lte': before}});
              if (after) dataset = dataset.find({'quoteOn': {'$gte': after}});
              if (likes) dataset = dataset.find({'likes': {'$gte': likes}});
              let results = dataset.simplesort('quoteOn', true).data();
              // Now that we have the result set, build our response
              if (results.length === 0) {
                message.channel.send('No matching quotes found! Time to get snapping! 📸');
              } else {
                message.channel.send('Exporting results! (this might take a while ...)').then(msg => {
                  createAndSendExport(results, message.channel, snapper, likes);
                });
              }
            } else {
              message.channel.send(`Sorry, I don't know someone called ${command[2]}. ` +
                `Make sure you are using a proper user mention! Don't worry about pinging them, I'm sure it'll be fine ;)`);
            }
          } else {
            message.channel.send('Who do you want me to export? :3');
          }
          break;
        case 'set':
          if (command[2]) {
            let channelId = getChannelFromMention(command[2]);
            let channel = guild.channels.get(channelId);
            if (channel) {
              let guilds = db.getCollection('guilds');
              let guildInfo = guilds.findOne({guildId: guild.id});
              if (guildInfo) {
                // Update old guild info
                guildInfo.channelId = channel.id;
              } else {
                // Add new info for this guild
                guilds.insert({
                  guildId: guild.id,
                  channelId: channel.id,
                  selfiesAllowed: DEFAULT_ALLOW_SELFIES,
                  reactThreshold: DEFAULT_REACT_THRESHOLD,
                  funPolice: DEFAULT_FUN_POLICE
                });
              }
              message.channel.send('Channel info saved! <o');
              db.saveDatabase();
            } else {
              message.channel.send(`Sorry, I don't see a channel here called ${command[2]}. ` +
                `Make sure you are using a proper channel mention!`);
            }
          } else {
            message.channel.send('What channel do you want me to post in? owo');
          }
          break;
        case 'help':
          let msg = '';
          msg += `${thisGuildInfo.reactThreshold} 📸 react${thisGuildInfo.reactThreshold === 1 ? '' : 's'} and I'll save the post. React with 👍 to show some love!\n`;
          if (thisGuildInfo.funPolice) {
            msg += 'Since the Fun Police came and confiscated all my score boards, I only have one non-admin command left. I hope you like it. ;~;\n';
          } else {
            msg += 'Here\'s what I know: *ahem*\n';
            msg += '**- top (<mention>)** shows the top 3 posts of all time, or for a user if mentioned\n';
            msg += '**- snaps** shows a leaderboard for most snapped users\n';
            msg += '**- likes** shows a leaderboard for collective likes on snaps\n';
          }
          msg += '**- export <mention>** fetches all the quotes for the specified user. This can be modified using additional parameters:\n';
          msg += '*- with <mention> <mention> ...* only exports quotes where the mentioned users took the snap\n';
          msg += '*- without <mention> <mention> ...* ignores quotes where the mentioned users took the snap (*and you give yourself away*)\n';
          msg += '*- before <YYYY-MM-DD>* only exports quotes said before the provided date\n';
          msg += '*- after <YYYY-MM-DD>* only exports quotes said after the provided date\n';
          msg += '*- snapper* will change the query to not take the specified users quotes, but quotes snapped by that user\n';
          msg += '*- likes <number>* limits results to only those recieving at least <number> likes\n';
          msg += '\nI also know the following admin commands: *ahem*\n';
          msg += '**- set <channel mention>** will mean future snaps will go to the mentioned channel. By default, they go to #scrapbook\n';
          msg += 'Oh, and **help** shows you this, aheh uwu';
          message.channel.send(msg);
      }
    } else {
      message.reply('hey qt! 👋');
    }
  }
});

async function createAndSendExport (results, channelToSend, snapper, likes) {
  let exportText = '... plus more in the export!';
  let msgText = null;
  let currentText = '';
  for (let i = 0; i < results.length; i++) {
    let result = results[i];
    let msg;
    let link = '';
    let author = '';
    let scrapChannel = channelToSend.guild.channels.get(result.botChannelId);
    try {
      let retrievedMsg = await scrapChannel.fetchMessage(result.botMessageId);
      msg = retrievedMsg.embeds[0];
      link = getMessageLink(scrapChannel.guild, scrapChannel, retrievedMsg);
      if (snapper) author = `- ${msg.author.name} `; // Not sure if name can be missing on an author but we know this is our embed
    } catch (err) {
      msg = {description: '<my snap deleted> 😭'};
    }
    let likeText = likes || likes === 0 ? `(${result.likes} like${result.likes === 1 ? '' : 's'}) ` : '';
    let messageToAppend = `#${i + 1} ${author}- ${msg.description || '*no text*'} ${likeText}${link}`;
    if (msg.image) messageToAppend += ` - ${msg.image.url}`;
    messageToAppend += '\n';
    if (messageToAppend.length + currentText.length + exportText.length > 2000 && !msgText) {
      // Big boi, scale him down
      if (currentText) {
        msgText = currentText + exportText;
      } else {
        msgText = 'Unfortunately, the first quote in this result set is too big, so I can\'t give you a preview! A suspenseful export indeed!';
      }
    }
    currentText += messageToAppend;
  }
  // end of results
  if (msgText) {
    // Needs an export
    let filename = `export4qt_${Date.now()}.txt`;
    channelToSend.send(msgText, {
      file: {
        attachment: Buffer.from(currentText),
        name: filename
      }
    });
  } else {
    // Can send like this
    channelToSend.send(currentText);
  }
}

function getUserFromMention (mention) {
  return mention.replace(/[<@!>]/g, '');
}

function getChannelFromMention (mention) {
  return mention.replace(/[<#>]/g, '');
}

function createScoreboard (scores, title, icon) {
  let sorted = scores.sort((a, b) => b.score - a.score);
  let desc = '';
  sorted.forEach(user => {
    desc += `${icon || '⭐'} (\`${user.score}\`) **${user.user.substring(0, 26)}**\n`;
  });
  return new Discord.RichEmbed().setTitle(title).setDescription(desc).setColor('RANDOM');
}

// RECURSIVE >:(
function sendEmbedList (results, channel, count) {
  if (results.length === 0) return;
  let result = results.shift();
  let scrapChannel = channel.guild.channels.get(result.botChannelId);
  try {
    scrapChannel.fetchMessage(result.botMessageId).then(retrivedMsg => {
      channel.send(`#${count} - ${result.likes} like${result.likes === 1 ? '' : 's'} ${getMessageLink(scrapChannel.guild, scrapChannel, retrivedMsg)}`,
        {embed: retrivedMsg.embeds[0]}).then(msg => {
        sendEmbedList(results, channel, count + 1);
      });
    });
  } catch (err) {
    winston.error(err);
    channel.send(`#${count} - ${result.likes} like${result.likes === 1 ? '' : 's'} - <my snap deleted> 😭`).then(msg => {
      sendEmbedList(results, channel, count + 1);
    });
  };
}

// https://github.com/discordjs/guide/blob/master/code-samples/popular-topics/reactions/raw-event.js
bot.on('raw', async event => {
  if (!events.hasOwnProperty(event.t)) return;

  const { d: data } = event;
  const user = bot.users.get(data.user_id);
  const channel = bot.channels.get(data.channel_id) || await user.createDM();
  let message = channel.messages.get(data.message_id);

  const emojiKey = (data.emoji.id) ? `${data.emoji.name}:${data.emoji.id}` : data.emoji.name;

  if (event.t === 'MESSAGE_REACTION_REMOVE' && message && message.reactions.get(emojiKey) && message.reactions.get(emojiKey).users.size) return;
  if (event.t === 'MESSAGE_REACTION_ADD' && message) return;

  if (!message) {
    message = await channel.fetchMessage(data.message_id);
  }
  let reaction = message.reactions.get(emojiKey);

  if (!reaction) {
    const emoji = new Discord.Emoji(bot.guilds.get(data.guild_id), data.emoji);
    reaction = new Discord.MessageReaction(message, emoji, 1, data.user_id === bot.user.id);
  }

  bot.emit(events[event.t], reaction, user);
});

bot.on('messageReactionAdd', function (messageReaction, user) {
  handleReaction(messageReaction, user);
});

bot.on('messageReactionRemove', function (messageReaction, user) {
  handleReaction(messageReaction, user, true);
});

bot.on('error', err => winston.error(err));

function handleReaction (messageReaction, user, removed) {
  if (!['📸', '👍', '👎'].includes(messageReaction.emoji.name)) return;
  let guild = messageReaction.message.guild;
  if (!guild) return;
  let thisGuildInfo = getGuildInfo(guild);
  if (!thisGuildInfo.scrapbookChannel) return;
  // Snap taken, get this message's info
  let scraps = db.getCollection('scraps');
  let messageInfo;
  switch (messageReaction.emoji.name) {
    case '📸':
      messageInfo = db.getCollection('scraps').findOne({'originalMessageId': messageReaction.message.id});
      if (!messageInfo) {
        // Insert a blank for use later
        messageInfo = scraps.insert({
          botMessageId: null,
          botChannelId: thisGuildInfo.scrapbookChannel.id,
          originalMessageId: messageReaction.message.id,
          authorId: messageReaction.message.author.id,
          channelId: messageReaction.message.channel.id,
          guildId: messageReaction.message.guild.id,
          snappedBy: [],
          quoteOn: messageReaction.message.createdTimestamp,
          likes: 0
        });
      }
      // Update message info. No need to leave someone holding the bag, as the embed will record whodunit
      // Let self snappers remove themselves if they came in before the update, but not add themselves after
      const index = messageInfo.snappedBy.indexOf(user.id);
      if (removed) {
        if (index !== -1) messageInfo.snappedBy.splice(index, 1);
      } else if (index === -1 && (thisGuildInfo.selfiesAllowed || messageReaction.message.author.id !== user.id)) {
        messageInfo.snappedBy.push(user.id);
      }
      db.saveDatabase();

      if (messageInfo.botMessageId === null & messageInfo.snappedBy.length >= thisGuildInfo.reactThreshold) {
        // New snap taken, post it!
        let msg = createEmbed(messageReaction.message, messageInfo.snappedBy);
        messageInfo.botMessageId = 'IN_PROGRESS';
        db.saveDatabase();
        thisGuildInfo.scrapbookChannel.send(msg.content, {embed: msg.embed}).then(botMessage => {
          messageInfo.botMessageId = botMessage.id;
          db.saveDatabase();
          botMessage.react('👍').then(msg => botMessage.react('👎'));
        });
      }
      break;
    case '👍':
    case '👎':
      messageInfo = db.getCollection('scraps').findOne({'botMessageId': messageReaction.message.id});
      if (!messageInfo) return;
      // Bump or unbump likes based on the event
      let direction = messageReaction.emoji.name === '👍' ? 1 : -1;
      let effect = removed ? -1 : 1;
      messageInfo.likes = messageInfo.likes + (direction * effect);
      db.saveDatabase();
  }
}

function getGuildInfo (guild) {
  let guilds = db.getCollection('guilds');
  let thisGuildInfo = guilds.findOne({guildId: guild.id});
  return thisGuildInfo
    ? {
      reactThreshold: thisGuildInfo.reactThreshold,
      selfiesAllowed: thisGuildInfo.selfiesAllowed,
      funPolice: thisGuildInfo.funPolice,
      scrapbookChannel: guild.channels.get(thisGuildInfo.channelId)
    } : {
      reactThreshold: DEFAULT_REACT_THRESHOLD,
      selfiesAllowed: DEFAULT_ALLOW_SELFIES,
      funPolice: DEFAULT_FUN_POLICE,
      scrapbookChannel: guild.channels.find(channel => channel.name === 'scrapbook')
    };
}

function getMention (userId) {
  return '<@' + userId + '>';
};

function formattedList (array) {
  return [array.slice(0, -1).join(', '), array.slice(-1)[0]].join(array.length < 2 ? '' : ' and ');
};

function mentionList (userIdArray) {
  const mentionArray = userIdArray.map(userId => getMention(userId));
  return formattedList(mentionArray);
}

function createEmbed (message, snappers) {
  // Converted and modified version of https://github.com/Rapptz/RoboDanny/blob/rewrite/cogs/stars.py#L168
  // Includes my own mod to repost an embed if snapped
  let origEmbed = message.embeds[0];
  let embed = new Discord.RichEmbed(origEmbed);
  let content = `📸 snapped by ${mentionList(snappers)} in ${message.channel} ${getMessageLink(message.guild, message.channel, message)}`;

  if (!origEmbed) {
    embed.setDescription(message.content);
  } else if (message.content !== '') {
    if (message.content.length <= 1024 && origEmbed.fields.length < 25) {
      embed.addField('Original Embed Message', message.content);
    } else {
      content += ' - original embed message content removed';
    }
  }

  let file = message.attachments.first();
  if (file) {
    if (endsWithAny(file.url.toLowerCase(), ['png', 'jpeg', 'jpg', 'gif', 'webp']) && !origEmbed) {
      embed.setImage(file.url);
    } else {
      // Either we can't read it or we are adding to an old embed
      embed.addField('Attachment', `[${file.filename}](${file.url})`);
    }
  }

  // Should not get unknown user from this, and guild should be here
  if (!embed.author) embed.setAuthor(getDisplayName(message.author, message.guild), message.author.displayAvatarURL);
  embed.setTimestamp(message.createdAt);
  // rip u
  embed.setColor('RANDOM');
  return {content: content, embed: embed};
}

function getDisplayName (userRef, guild) {
  let userId = userRef.id || userRef;
  let baseUser = bot.users.get(userId);
  let guildUser = guild ? guild.member(baseUser) : null;
  return guildUser ? guildUser.displayName : baseUser ? baseUser.username : `👻 ID: ${userId}`;
}

function endsWithAny (string, array) {
  for (let i = 0; i < array.length; i++) {
    if (string.endsWith(array[i])) return true;
  }
  return false;
}

// https://stackoverflow.com/questions/14446511/what-is-the-most-efficient-method-to-groupby-on-a-javascript-array-of-objects
function groupByArray (xs, key) {
  return xs.reduce(function (rv, x) {
    let v = key instanceof Function ? key(x) : x[key];
    let el = rv.find((r) => r && r.key === v);
    if (el) { el.values.push(x); } else { rv.push({ key: v, values: [x] }); }
    return rv;
  }, []);
}

function getMessageLink (guild, channel, message) {
  let guildId = guild ? guild.id : '@me';
  return `https://discordapp.com/channels/${guildId}/${channel.id}/${message.id}`;
}

function isKnownUser (userId) {
  // dumpster dive
  return db.getCollection('scraps').chain()
    .find({'botMessageId': {'$nin': [null, 'IN_PROGRESS']}})
    .where(obj => obj.authorId === userId || obj.snappedBy.includes(userId)).data().length > 0;
}

function init (callback) {
  if (initalised) return;
  initalised = true;
  db = new Loki('./scrapbook.json');

  db.loadDatabase({}, function (err) {
    if (err) {
      callback(err);
    } else {
      let scraps = db.getCollection('scraps');
      let guilds = db.getCollection('guilds');
      if (!scraps) {
        db.addCollection('scraps');
      }
      if (!guilds) {
        db.addCollection('guilds');
      }
      db.saveDatabase(function (err) {
        if (err) {
          callback(err);
        } else {
          winston.info('Init worked, calling back.');
          callback();
        }
      });
    }
  });
};
