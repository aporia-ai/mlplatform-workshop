import os
import uvicorn
import mlflow
import numpy as np
import pandas as pd
from fastapi import FastAPI, Request
from pydantic import BaseModel


class Size(BaseModel):
    length: float
    width: float

class PredictRequest(BaseModel):
    sepal: Size
    petal: Size


app = FastAPI()

model = mlflow.lightgbm.load_model(f'runs:/{os.environ["MLFLOW_RUN_ID"]}/model')
flower_name_by_index = {0: 'Setosa', 1: 'Versicolor', 2: 'Virginica'}


@app.post("/predict")
def predict(request: PredictRequest):
    df = pd.DataFrame(columns=['sepal.length', 'sepal.width', 'petal.length', 'petal.width'],
                      data=[[request.sepal.length, request.sepal.width, request.petal.length, request.petal.width]])

    y_pred = np.argmax(model.predict(df))
    return {"flower": flower_name_by_index[y_pred]}


def main():
    uvicorn.run(app, host="0.0.0.0", port=8000)

if __name__ == "__main__":
    main()
