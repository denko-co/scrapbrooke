const Discord = require('discord.js');
const Loki = require('lokijs');
const bot = new Discord.Client({autoReconnect: true});
const reactThreshold = 3;
// const timeTillLate = 86400; // One day
const events = {
  MESSAGE_REACTION_ADD: 'messageReactionAdd',
  MESSAGE_REACTION_REMOVE: 'messageReactionRemove'
};
let initalised = false;
let db;

init(function (err) {
  if (err) {
    console.log(err);
    process.exit(1);
  }
  console.log('Ready to rock!');
});

bot.login(process.env.TOKEN);

bot.on('ready', function (event) {
  console.log('Logged in as %s - %s\n', bot.user.username, bot.user.id);
});

bot.on('message', function (message) {
  // Handle commands
  if (!message.author.bot) {
    let guild = message.guild;
    if (!guild) return;
    let scrapbookChannel = guild.channels.find(channel => channel.name === 'scrapbook');
    if (!scrapbookChannel) return;
    let command = message.content.match(/\S+/g) || [];
    if (command[0] !== bot.user.toString()) return;
    if (command[1]) {
      let scraps = db.getCollection('scraps');
      switch (command[1]) {
        case 'posts':
          let results = scraps.chain().simplesort('likes', true).limit(3).data();
          message.channel.send('Here are the top 3 most popular snaps of all time. *ahem*').then(msg => {
            sendEmbedList(results, message.channel, scrapbookChannel, 1);
          });
          break;
        case 'snaps':
          let snappedUsers = groupByArray(scraps.chain().data(), 'authorId');
          let snappedScores = snappedUsers.map(user => {
            return {user: guild.member(bot.users.get(user.key)).displayName, score: user.values.length};
          });
          message.channel.send('', {embed: createScoreboard(snappedScores, 'Users most snapped')});
          break;
        case 'likes':
          let scoredUsers = groupByArray(scraps.chain().data(), 'authorId');
          let scoredScores = scoredUsers.map(user => { // I really do crack myself up sometimes
            return {
              user: guild.member(bot.users.get(user.key)).displayName,
              score: user.values.reduce(function (current, ele) {
                return current + ele.likes;
              }, 0)};
          });
          message.channel.send('', {embed: createScoreboard(scoredScores, 'Most liked users')});
          break;
        case 'me':
          let myresults = scraps.chain().find({authorId: message.author.id}).simplesort('likes', true).limit(3).data();
          message.channel.send('Here are your top 3 most popular snaps. *ahem*').then(msg => {
            sendEmbedList(myresults, message.channel, scrapbookChannel, 1);
          });
          break;
        case 'help':
          let msg = 'Here\'s what I know: *ahem*\n';
          msg += '**- posts** shows the top 3 posts of all time\n';
          msg += '**- me** shows your top 3 posts (of all time)\n';
          msg += '**- snaps** shows a leaderboard for most snapped users\n';
          msg += '**- likes** shows a leaderboard for collective likes on snaps\n';
          msg += 'Oh, and **help** shows you this, aheh uwu';
          message.channel.send(msg);
      }
    } else {
      message.reply('👋');
    }
  }
});

function createScoreboard (scores, title) {
  let sorted = scores.sort((a, b) => b.score - a.score);
  let desc = '';
  sorted.forEach(user => {
    desc += `⭐ (\`${user.score}\`) **${user.user.substring(0, 24)}**\n`;
  });
  return new Discord.RichEmbed().setTitle(title).setDescription(desc).setColor('RANDOM');
}

function sendEmbedList (results, channel, scrapChannel, count) {
  if (results.length === 0) return;
  let result = results.shift();
  scrapChannel.fetchMessage(result.botMessageId).then(retrivedMsg => {
    channel.send(`#${count} - ${result.likes} like${result.likes === 1 ? '' : 's'}`, {embed: retrivedMsg.embeds[0]}).then(msg => {
      sendEmbedList(results, channel, scrapChannel, count + 1);
    });
  });
}

// https://github.com/discordjs/guide/blob/master/code-samples/popular-topics/reactions/raw-event.js
bot.on('raw', async event => {
  if (!events.hasOwnProperty(event.t)) return;

  const { d: data } = event;
  const user = bot.users.get(data.user_id);
  const channel = bot.channels.get(data.channel_id) || await user.createDM();

  if (channel.messages.has(data.message_id)) return;

  const message = await channel.fetchMessage(data.message_id);
  const emojiKey = (data.emoji.id) ? `${data.emoji.name}:${data.emoji.id}` : data.emoji.name;
  let reaction = message.reactions.get(emojiKey);

  if (!reaction) {
    const emoji = new Discord.Emoji(bot.guilds.get(data.guild_id), data.emoji);
    reaction = new Discord.MessageReaction(message, emoji, 1, data.user_id === bot.user.id);
  }

  bot.emit(events[event.t], reaction, user);
});

bot.on('messageReactionAdd', function (messageReaction) {
  handleReaction(messageReaction);
});

bot.on('messageReactionRemove', function (messageReaction) {
  handleReaction(messageReaction);
});

function handleReaction (messageReaction) {
  if (!['📸', '👍'].includes(messageReaction.emoji.name)) return;
  let guild = messageReaction.message.guild;
  if (!guild) return;
  let scrapbookChannel = guild.channels.find(channel => channel.name === 'scrapbook');
  if (!scrapbookChannel) return;
  // Snap taken, get this message's info
  let scraps = db.getCollection('scraps');
  let messageInfo;
  switch (messageReaction.emoji.name) {
    case '📸':
      messageInfo = db.getCollection('scraps').findOne({'originalMessageId': messageReaction.message.id});
      if (messageReaction.count >= reactThreshold && !messageInfo) {
        // New snap taken, post it!
        let msg = createEmbed(messageReaction.message);
        scrapbookChannel.send(msg.content, {embed: msg.embed}).then(botMessage => {
          scraps.insert({
            botMessageId: botMessage.id,
            originalMessageId: messageReaction.message.id,
            authorId: messageReaction.message.author.id,
            channelId: messageReaction.message.channel.id,
            likes: 1
          });
          db.saveDatabase();
          botMessage.react('👍');
        });
      }
      break;
    case '👍':
      messageInfo = db.getCollection('scraps').findOne({'botMessageId': messageReaction.message.id});
      if (!messageInfo) return;
      messageInfo.likes = messageReaction.count;
      db.saveDatabase();
  }
}

function createEmbed (message) {
  // Converted and modified version of https://github.com/Rapptz/RoboDanny/blob/rewrite/cogs/stars.py#L168
  let embed = new Discord.RichEmbed();
  embed.setDescription(message.content);
  let content = `📸 ${message.channel}`;

  if (message.embeds.length > 0) {
    let data = message.embeds[0];
    if (data.type === 'image') {
      embed.setImage(data.url);
    }
  }

  let file = message.attachments.first();
  if (file) {
    if (endsWithAny(file.url.toLowerCase(), ['png', 'jpeg', 'jpg', 'gif', 'webp'])) {
      embed.setImage(file.url);
    } else {
      embed.addField('Attachment', `[${file.filename}](${file.url})`);
    }
  }

  // Guild is present here, will work but just in case
  let author = message.guild ? message.guild.member(message.author).displayName : message.author.username;
  embed.setAuthor(author, message.author.displayAvatarURL);
  embed.setTimestamp(message.createdAt);
  // rip u
  embed.setColor('RANDOM');
  return {content: content, embed: embed};
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

function init (callback) {
  if (initalised) return;
  initalised = true;
  db = new Loki('./scrapbook.json');

  db.loadDatabase({}, function (err) {
    if (err) {
      callback(err);
    } else {
      let scraps = db.getCollection('scraps');
      if (!scraps) {
        db.addCollection('scraps');
      }
      db.saveDatabase(function (err) {
        if (err) {
          callback(err);
        } else {
          console.log('Init worked, calling back.');
          callback();
        }
      });
    }
  });
};
