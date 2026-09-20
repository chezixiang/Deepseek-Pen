// 宿主侧 mint 调试：调用 mint_device_id 并打印结果（DS_MINT_DUMP 可落盘请求体）
// 运行：cargo run --example mint_probe
#[tokio::main]
async fn main() {
    let ua = ds_free_api::ds_core::default_user_agent();
    match ds_free_api::ds_core::mint_device_id(&ua).await {
        Ok((id, smid)) => println!(
            "MINT_OK device_id_len={} prefix={} smid_len={}",
            id.len(),
            id.chars().next().unwrap_or('?'),
            smid.len()
        ),
        Err(e) => println!("MINT_ERR {e}"),
    }
}
