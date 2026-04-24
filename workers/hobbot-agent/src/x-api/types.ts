export interface XApiCredentials {
  consumerKey: string
  consumerSecret: string
  accessToken: string
  accessSecret: string
}

export interface TweetResponse {
  data: {
    id: string
    text: string
  }
}

export interface TweetMetrics {
  data: {
    id: string
    public_metrics: {
      retweet_count: number
      reply_count: number
      like_count: number
      quote_count: number
      bookmark_count: number
      impression_count: number
    }
  }
}

export interface MediaUploadInit {
  media_id_string: string
}

export interface MediaUploadFinalize {
  media_id_string: string
  processing_info?: {
    state: string
    check_after_secs: number
  }
}
