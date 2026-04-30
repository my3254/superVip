const PLATFORMS = [
  {
    id: 'iqiyi',
    name: '爱奇艺',
    homeUrl: 'https://www.iqiyi.com/',
    domain: 'iqiyi.com',
    patterns: [/iqiyi\.com\/v_/, /iqiyi\.com\/a_/],
    extractId: (url) => {
      const match = url.match(/v_(\w+)/) || url.match(/a_(\w+)/);
      return match ? match[1] : null;
    }
  },
  {
    id: 'youku',
    name: '优酷',
    homeUrl: 'https://www.youku.com/',
    domain: 'youku.com',
    patterns: [/youku\.com\/v_show\/id_/],
    extractId: (url) => {
      const match = url.match(/id_(\w+)/);
      return match ? match[1] : null;
    }
  },
  {
    id: 'tencent',
    name: '腾讯视频',
    homeUrl: 'https://v.qq.com/',
    domain: 'v.qq.com',
    patterns: [/v\.qq\.com\/x\/page/, /v\.qq\.com\/x\/cover/],
    extractId: (url) => {
      const match = url.match(/page\/(\w+)/) || url.match(/cover\/(\w+)/);
      return match ? match[1] : null;
    }
  },
  {
    id: 'mgtv',
    name: '芒果TV',
    homeUrl: 'https://www.mgtv.com/',
    domain: 'mgtv.com',
    patterns: [/mgtv\.com\/b/],
    extractId: (url) => {
      const match = url.match(/b\/(\w+)/);
      return match ? match[1] : null;
    }
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    homeUrl: 'https://www.bilibili.com/',
    domain: 'bilibili.com',
    patterns: [
      /bilibili\.com\/video\/(BV\w+|av\d+)/,
      /bilibili\.com\/bangumi\/play\/ep\d+/,
      /bilibili\.com\/bangumi\/play\/ss\d+/
    ],
    extractId: (url) => {
      let match = url.match(/video\/(BV\w+|av\d+)/);
      if (match) return match[1];
      match = url.match(/bangumi\/play\/ep(\d+)/);
      if (match) return match[1];
      match = url.match(/bangumi\/play\/ss(\d+)/);
      if (match) return match[1];
      return null;
    }
  },
  {
    id: 'sohu',
    name: '搜狐视频',
    homeUrl: 'https://tv.sohu.com/',
    domain: 'sohu.com',
    patterns: [/tv\.sohu\.com\/v/, /film\.sohu\.com\/album\/(\d+)/],
    extractId: (url) => {
      let match = url.match(/v\/(\w+)/);
      if (match) return match[1];
      match = url.match(/album\/(\d+)/);
      if (match) return match[1];
      return null;
    }
  },
  {
    id: 'le',
    name: '乐视视频',
    homeUrl: 'https://www.le.com/',
    domain: 'le.com',
    patterns: [
      /le\.com\/vplay_/,
      /letv\.com\/ptv\/pplay\/(\d+)\/(\d+)/,
      /le\.com\/ptv\/pplay\/(\d+)\/(\d+)/,
      /le\.com\/ptv\/vplay\/(\d+)\.html/
    ],
    extractId: (url) => {
      let match = url.match(/vplay_(\w+)/);
      if (match) return match[1];
      match = url.match(/pplay\/(\d+)\/(\d+)/);
      if (match) return `${match[1]}_${match[2]}`;
      match = url.match(/vplay\/(\d+)\.html/);
      if (match) return match[1];
      return null;
    }
  }
];

const DEFAULT_INTERFACES = [
  {
    id: 'interface_1',
    name: '默认接口',
    url: 'https://jx.xmflv.com/?url='
  },
  {
    id: 'interface_2',
    name: '接口1',
    url: 'https://www.pangujiexi.com/jiexi/?url='
  },
  {
    id: 'interface_3',
    name: '接口2',
    url: 'https://www.8090g.cn/jiexi/?url='
  },
  {
    id: 'interface_4',
    name: '接口3',
    url: 'https://www.playm3u8.cn/jiexi.php?url='
  },
  {
    id: 'interface_5',
    name: '接口4',
    url: 'https://jx.nnxv.cn/tv.php?url='
  },
  {
    id: 'interface_6',
    name: '接口5',
    url: 'https://jx.xymp4.cc/?url='
  },
  {
    id: 'interface_7',
    name: '接口6',
    url: 'https://www.ckplayer.vip/jiexi/?url='
  },
  {
    id: 'interface_8',
    name: '接口7',
    url: 'https://www.pouyun.com/?url='
  },
  {
    id: 'interface_9',
    name: '接口8',
    url: 'https://www.wpsseo.cn/jiexi/?jx='
  },
  {
    id: 'interface_10',
    name: '接口9',
    url: 'https://jx.77flv.cc/?url='
  },
  {
    id: 'interface_11',
    name: '接口10',
    url: 'https://jx.m3u8.tv/jiexi/?url='
  },
  {
    id: 'interface_12',
    name: '接口11',
    url: 'https://jx.playerjy.com/?ads=0&url='
  },
  {
    id: 'interface_13',
    name: '接口12',
    url: 'https://yparse.ik9.cc/index.php?url='
  }
];

function detectPlatform(url) {
  if (!url) {
    return null;
  }

  for (const platform of PLATFORMS) {
    for (const pattern of platform.patterns) {
      if (pattern.test(url)) {
        return {
          platform,
          videoId: platform.extractId(url)
        };
      }
    }
  }
  return null;
}

function generateParseUrl(interfaceUrl, videoUrl) {
  return `${interfaceUrl}${encodeURIComponent(videoUrl)}`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    PLATFORMS,
    DEFAULT_INTERFACES,
    detectPlatform,
    generateParseUrl
  };
}
