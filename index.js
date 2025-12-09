require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, getVoiceConnection } = require('@discordjs/voice');
const play = require('play-dl');

const TOKEN = process.env.TOKEN;
const PREFIX = process.env.PREFIX || '!';

if (!TOKEN) {
  console.error('Hata: .env içinde TOKEN yok!');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [ Partials.Message, Partials.Channel, Partials.Reaction ]
});

// Basit guild -> queue yapısı
const queues = new Map(); // guildId => { player, connection, songs:[], playing }

function getOrCreateLogChannel(guild) {
  // server-logs isimli kanalı bul veya oluştur
  const existing = guild.channels.cache.find(c => c.name === 'server-logs' && c.type === 0);
  if (existing) return existing;
  // oluştur (text)
  return guild.channels.create({ name: 'server-logs', type: 0, reason: 'Log kanalı oluşturuluyor.' });
}

async function log(guild, title, description) {
  try {
    const ch = await getOrCreateLogChannel(guild);
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('Log kanalı hata:', err);
  }
}

/* ----------------- MÜZİK YARDIMCI FONKSİYONLARI ----------------- */

async function ensureQueue(guildId) {
  if (!queues.has(guildId)) {
    const player = createAudioPlayer();
    queues.set(guildId, { player, connection: null, songs: [], playing: false });
  }
  return queues.get(guildId);
}

async function playNext(guild) {
  const q = queues.get(guild.id);
  if (!q) return;
  const next = q.songs.shift();
  if (!next) {
    q.playing = false;
    // bağlantıyı kapatma: istersen belirli süre sonra kapatabilirsin
    const conn = getVoiceConnection(guild.id);
    if (conn) {
      // 5 dakikaya kadar bekleyip kapatmak istersen zamanlayıcı koy
      setTimeout(() => {
        const c = getVoiceConnection(guild.id);
        if (c && !q.playing) c.destroy();
      }, 5 * 60 * 1000);
    }
    return;
  }

  try {
    // play-dl ile stream al
    const source = await play.stream(next.url, { quality: 2, discordPlayerCompatibility: true });
    const resource = createAudioResource(source.stream, { inputType: source.type });
    q.player.play(resource);
    q.playing = true;

    q.player.once(AudioPlayerStatus.Idle, () => {
      playNext(guild);
    });
  } catch (err) {
    console.error('Oynatmada hata:', err);
    playNext(guild);
  }
}

/* ----------------- EVENTLER: LOGLAR ----------------- */

// Üye katılma / ayrılma
client.on('guildMemberAdd', member => {
  log(member.guild, 'Üye Katıldı', `${member.user.tag} sunucuya katıldı.`);
  // otomatik rol vermek istersen buraya ekle
});

client.on('guildMemberRemove', member => {
  log(member.guild, 'Üye Ayrıldı', `${member.user.tag} sunucudan ayrıldı.`);
});

// Ses durum değişimi: join / leave / move / mute / deafen
client.on('voiceStateUpdate', (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  // join
  if (!oldState.channelId && newState.channelId) {
    log(guild, 'Ses Kanalına Katıldı', `${newState.member.user.tag} → ${newState.channel.name}`);
    return;
  }
  // leave
  if (oldState.channelId && !newState.channelId) {
    log(guild, 'Ses Kanalından Ayrıldı', `${oldState.member.user.tag} ← ${oldState.channel.name}`);
    return;
  }
  // move
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    log(guild, 'Ses Kanalı Değiştirildi', `${newState.member.user.tag} → ${oldState.channel.name} -> ${newState.channel.name}`);
    return;
  }
  // mute/deafen değişiklikleri
  if (oldState.serverMute !== newState.serverMute) {
    log(guild, 'Susturma Durumu Değişti', `${newState.member.user.tag} susturma: ${newState.serverMute}`);
  }
  if (oldState.serverDeaf !== newState.serverDeaf) {
    log(guild, 'Sağırlaştırma Durumu Değişti', `${newState.member.user.tag} sağırlaştırma: ${newState.serverDeaf}`);
  }
});

// Role create/update/delete
client.on('roleCreate', role => {
  log(role.guild, 'Rol Oluşturuldu', `${role.name} oluşturuldu.`);
});
client.on('roleDelete', role => {
  log(role.guild, 'Rol Silindi', `${role.name} silindi.`);
});
client.on('roleUpdate', (oldRole, newRole) => {
  log(oldRole.guild, 'Rol Güncellendi', `${oldRole.name} -> ${newRole.name}`);
});

// Mesaj silinme / düzenleme
client.on('messageDelete', message => {
  if (!message.guild) return;
  // parsable content (partial olabilir)
  const content = message.content ? message.content : '[Gönderi içeriksiz veya partial]';
  log(message.guild, 'Mesaj Silindi', `Kullanıcı: ${message.author?.tag || 'Bilinmiyor'}\nKanal: ${message.channel?.name || 'bilinmiyor'}\nİçerik: ${content}`);
});

client.on('messageUpdate', (oldMessage, newMessage) => {
  if (!oldMessage.guild) return;
  const oldC = oldMessage.content || '[eski içerik yok]';
  const newC = newMessage.content || '[yeni içerik yok]';
  log(oldMessage.guild, 'Mesaj Düzenlendi', `Kullanıcı: ${oldMessage.author?.tag || 'Bilinmiyor'}\nKanal: ${oldMessage.channel?.name || 'bilinmiyor'}\nEski: ${oldC}\nYeni: ${newC}`);
});

// Rol değişiklikleri (kullanıcıya rol eklenmesi/çıkarılması) için guildMemberUpdate kullanılır
client.on('guildMemberUpdate', (oldMember, newMember) => {
  // roller farklı mı kontrol et
  const oldRoles = oldMember.roles.cache.map(r => r.id).join(',');
  const newRoles = newMember.roles.cache.map(r => r.id).join(',');
  if (oldRoles !== newRoles) {
    const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id)).map(r => r.name);
    const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id)).map(r => r.name);
    if (added.length) log(newMember.guild, 'Rol Eklendi', `${newMember.user.tag} roller eklendi: ${added.join(', ')}`);
    if (removed.length) log(newMember.guild, 'Rol Çıkarıldı', `${newMember.user.tag} roller kaldırıldı: ${removed.join(', ')}`);
  }
});

/* ----------------- MESAJ İŞLEME: PREFIX KOMUTLAR ----------------- */

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/g);
  const cmd = args.shift().toLowerCase();

  // basit !çal komutu (YouTube linki veya arama kelimesi)
  if (cmd === 'çal' || cmd === 'play') {
    const query = args.join(' ');
    if (!query) return message.reply('Bir şarkı ismi veya bağlantısı gir. Örnek: `!çal <url veya isim>`');

    const memberVoice = message.member.voice;
    if (!memberVoice.channel) return message.reply('Önce bir ses kanalına katıl.');

    // queue hazırla
    const guildId = message.guild.id;
    const q = await ensureQueue(guildId);

    // resolve track
    let url = null;
    let info = null;
    try {
      if (play.yt_validate(query) === 'video' || play.yt_validate(query) === 'playlist') {
        url = query;
      } else {
        // arama yap
        const search = await play.search(query, { limit: 1 });
        if (!search || search.length === 0) return message.reply('Şarkı bulunamadı.');
        url = search[0].url;
        info = search[0];
      }

      // ekle
      q.songs.push({ title: info?.title || url, url });
      await message.reply(`🎶 Kuyruğa eklendi: ${info?.title || url}`);

      // bağlanma
      if (!q.connection) {
        const conn = joinVoiceChannel({
          channelId: memberVoice.channel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator
        });
        q.connection = conn;
        q.player = q.player ?? createAudioPlayer();
        conn.subscribe(q.player);
      }

      // eğer çalmıyorsa başlat
      if (!q.playing) {
        playNext(message.guild);
      }
    } catch (err) {
      console.error('çal hatası', err);
      return message.reply('Şarkı çalarken hata oluştu.');
    }
  }

  // !durdur
  if (cmd === 'durdur' || cmd === 'stop') {
    const guildId = message.guild.id;
    const q = queues.get(guildId);
    if (!q) return message.reply('Şu anda hiçbir şey çalmıyor.');
    if (q.player) q.player.stop();
    q.songs = [];
    q.playing = false;
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
    await message.reply('⏹️ Müzik durduruldu ve kuyruk temizlendi.');
  }

  // !atla
  if (cmd === 'atla' || cmd === 'skip') {
    const guildId = message.guild.id;
    const q = queues.get(guildId);
    if (!q || !q.playing) return message.reply('Atlayacak şarkı yok.');
    q.player.stop(); // player idle olunca playNext tetiklenecek
    await message.reply('⏭️ Şarkı atlandı.');
  }

  // !kuyruk
  if (cmd === 'kuyruk' || cmd === 'queue') {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply('Kuyruk boş.');
    const list = q.songs.map((s, i) => `${i+1}. ${s.title || s.url}`).join('\n');
    await message.reply(`🎵 Kuyruk:\n${list}`);
  }

  // !çalınan (şu an çalan bilgisi)
  if (cmd === 'şuankişarkı' || cmd === 'now' || cmd === 'nowplaying') {
    const q = queues.get(message.guild.id);
    if (!q || !q.playing) return message.reply('Şu anda çalan yok.');
    // play-dl ile şu anki başlığı göstermemiz için kuyruk tutuyoruz
    const current = q.songs[0] || { title: 'Bilinmiyor' };
    message.reply(`🎧 Şu an: ${current.title || current.url}`);
  }
});

/* ----------------- BOT START ----------------- */

client.once('ready', () => {
  console.log(`Bot hazır: ${client.user.tag}`);
});

client.login(TOKEN);
