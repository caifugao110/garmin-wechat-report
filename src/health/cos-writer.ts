/**
 * 腾讯云 COS 上传工具（仅用于 SCF 端写体重数据）
 *
 * 使用 cos-nodejs-sdk-v5（esbuild bundle 进 SCF 产物），避免手写签名出错。
 * Worker 端读 COS 走公有读，直接 fetch 即可（见 weight.ts）。
 */

import COS from 'cos-nodejs-sdk-v5';

export interface CosWriterConfig {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
}

let client: COS | null = null;

function getClient(config: CosWriterConfig): COS {
  if (!client) {
    client = new COS({
      SecretId: config.secretId,
      SecretKey: config.secretKey,
    });
  }
  return client;
}

/**
 * 把体重测量记录上传到 COS，覆盖同一日期的旧记录。
 * 对象 key：weight/{date}.json
 */
export async function putWeightToCos(
  config: CosWriterConfig,
  date: string,
  bodyJson: string,
): Promise<void> {
  const cos = getClient(config);
  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      {
        Bucket: config.bucket,
        Region: config.region,
        Key: `weight/${date}.json`,
        Body: Buffer.from(bodyJson, 'utf-8'),
        ContentType: 'application/json',
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}
