use std::env;
use std::ops::Deref;

use anyhow::{Context, Result};
use itertools::Itertools;
use linfa::DatasetBase;
use linfa::traits::{Fit, FitWith, Predict};
use linfa_clustering::{IncrKMeansError, KMeans, KMeansParams};
use linfa_nn::distance::L2Dist;
// use linfa_datasets::generate;
use ndarray::{ArrayBase, Axis, Dim, OwnedRepr, array, s};
use qdrant_client::qdrant::vectors_output::VectorsOptions;
use qdrant_client::qdrant::{
    PointsIdsList, ScrollPointsBuilder, ScrollResponse, SetPayloadPointsBuilder,
};
use qdrant_client::{Payload, Qdrant};
use rand::thread_rng;
// use ndarray_rand::rand::SeedableRng;
// use rand_xoshiro::Xoshiro256Plus;
// use approx::assert_abs_diff_eq;

use linfa::Dataset;
use ndarray::{Array1, Array2};
use serde_json::json;
use tokio::fs::{read, read_to_string, try_exists, write};
// use prost_types::value::Kind as ProstKind;

fn dataset_from_qdrant(
    response: &ScrollResponse,
) -> DatasetBase<
    ArrayBase<OwnedRepr<f64>, Dim<[usize; 2]>>,
    ArrayBase<OwnedRepr<()>, Dim<[usize; 1]>>,
> {
    let mut features: Vec<Vec<f64>> = Vec::new();
    // let mut labels: Vec<String> = Vec::new();

    for p in &response.result {
        if let Some(vs) = &p.vectors {
            // Extract a single dense vector from Qdrant's Vectors (named or unnamed)
            let maybe_vec_f64: Option<Vec<f64>> = match &vs.vectors_options {
                Some(VectorsOptions::Vector(v)) => Some(v.data.iter().map(|&x| x as f64).collect()),
                Some(VectorsOptions::Vectors(map)) => {
                    if let Some(v) = map.vectors.get("default") {
                        Some(v.data.iter().map(|&x| x as f64).collect())
                    } else if let Some((_name, v)) = map.vectors.iter().next() {
                        Some(v.data.iter().map(|&x| x as f64).collect())
                    } else {
                        None
                    }
                }
                None => None,
            };

            if let Some(feature_vec) = maybe_vec_f64 {
                // Prefer numeric point id as label; fall back to payload["label"] or payload["id"]
                // let label = p.payload.get("id").unwrap().to_string();

                features.push(feature_vec);
                // labels.push(label);
            }
        }
    }

    let n_samples = features.len();
    let n_features = features.first().map_or(0, |v| v.len());

    if n_samples == 0 || n_features == 0 {
        return DatasetBase::from(Array2::<f64>::zeros((0, 0)));
    }

    let flat: Vec<f64> = features.into_iter().flatten().collect();
    println!("flattening done");
    let records =
        Array2::from_shape_vec((n_samples, n_features), flat).expect("invalid dataset shape");
    // let targets = Array1::from(labels);

    DatasetBase::from(records)
}

const MODEL_FILE: &str = "model.josn";

#[tokio::main]
async fn main() -> Result<()> {
    // Our random number generator, seeded for reproducibility
    // let seed = 42;
    // let rng = thread_rng();

    let collection_name = "messages";
    // dbg!(collections_list);

    let client = Qdrant::from_url(&env::var("QDRAN_URL")?)
        .api_key(env::var("QDRAN_KEY")?)
        .build()?;

    let batch_size = 500;

    let n_clusters = 25;
    let clf = KMeans::params_with_rng(n_clusters, thread_rng()).tolerance(1e-3);

    let mut offset = None;
    let mut model: Option<KMeans<f64, L2Dist>> = None;

    if try_exists(MODEL_FILE).await? {
        model = serde_json::from_str(&read_to_string(MODEL_FILE).await?)?;
    }

    loop {
        let mut scroll_points_builder = ScrollPointsBuilder::new(collection_name)
            .limit(batch_size)
            .with_payload(true)
            .with_vectors(true);
        if let Some(offset) = offset {
            scroll_points_builder = scroll_points_builder.offset(offset);
        }
        let batch: qdrant_client::qdrant::ScrollResponse =
            client.scroll(scroll_points_builder).await?;
        offset = batch.next_page_offset.clone();
        let dataset = dataset_from_qdrant(&batch);
        println!("running for offset {:?}", offset);
        match clf.fit_with(model, &dataset) {
            Ok(new_model) => {
                model = Some(new_model);
                break;
            }
            Err(IncrKMeansError::NotConverged(new_model)) => {
                model = Some(new_model);
            }
            Err(err) => panic!("unexpected kmeans error: {}", err),
        }
        if batch.next_page_offset.is_none() {
            break;
        }
    }

    // dbg!(&model);
    write(MODEL_FILE, serde_json::to_string(&model)?.as_bytes()).await?;
    let model = model.context("should exist")?;

    let update_batch_size = 10_000;
    let mut offset = None;
    loop {
        let mut scroll_points_builder = ScrollPointsBuilder::new(collection_name)
            .limit(update_batch_size)
            .with_payload(true)
            .with_vectors(true);
        if let Some(offset) = offset {
            scroll_points_builder = scroll_points_builder.offset(offset);
        }
        let batch: qdrant_client::qdrant::ScrollResponse =
            client.scroll(scroll_points_builder).await?;
        offset = batch.next_page_offset.clone();
        let new_observation = dataset_from_qdrant(&batch);
        let dataset = model.predict(new_observation);
        // dbg!(&dataset.targets());
        let targets = dataset.targets();
        for (cluster_id, points) in batch
            .result
            .into_iter()
            .map(|v| v.id)
            .enumerate()
            .into_group_map_by(|(i, x)| targets[*i])
            .iter()
        {
            {
                client
                    .set_payload(
                        SetPayloadPointsBuilder::new(
                            collection_name,
                            Payload::try_from(json!({
                                "cluster_id": cluster_id,
                            }))
                            .unwrap(),
                        )
                        .points_selector(PointsIdsList {
                            ids: points.iter().filter_map(|(_, p)| p.clone()).collect(),
                        })
                        .wait(true),
                    )
                    .await?;
            }
        }
        if batch.next_page_offset.is_none() {
            break;
        }
    }

    // let new_observation = DatasetBase::from(array![[-9., 20.5]]);
    // let dataset = model.predict(new_observation);
    // let closest_centroid = dataset.targets()[0];

    Ok(())
}
